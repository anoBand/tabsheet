"""핵심 로직 (CLI/MCP/웹이 공통으로 쓰는 순수 라이브러리).

파이프라인
  1. 영상에서 일정 간격으로 프레임을 샘플링 (스트리밍, 메모리에 다 올리지 않음)
  2. 사용자가 지정한 bbox(악보 영역)만 크롭
  3. 연속 샘플 간 '변화 점수'로 안정 구간(= 한 악보가 화면에 정지해 있는 구간)을 찾음
     - 페이드 전환/움직이는 커서/영역 밖 노이즈에 견디도록 설계
  4. 구간마다 가장 선명한 프레임을 대표 이미지로 선택
  5. 직전 악보와 같은 것은 병합, 앞뒤 페이지의 혼합(크로스페이드 중간)으로 설명되는 짧은 후보는 제외 표시
  6. 대표 이미지들을 페이지에 쌓아 PDF 또는 JPG로 출력
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

import cv2
import numpy as np
from PIL import Image

BBox = tuple[int, int, int, int]  # x, y, w, h (픽셀)


# --------------------------------------------------------------------------- #
# 파라미터 / 결과 타입
# --------------------------------------------------------------------------- #
@dataclass
class Params:
    interval: float = 0.5        # 샘플링 간격(초)
    pix_thr: int = 25            # 픽셀 밝기 차이가 이 값을 넘으면 '변했다'
    stable_thr: float = 0.10     # 직전 샘플과의 변화 점수가 이 이하면 '같은 악보'
    anchor_thr: float = 0.20     # 구간 첫 샘플과의 변화 점수 한계 (느린 페이드 방지)
    min_run: int = 2             # 안정 구간으로 인정할 최소 연속 샘플 수
    dedupe_thr: float = 0.05     # 직전에 채택한 악보와 이 이하면 같은 악보로 병합
    fade_ratio: float = 0.75     # 앞뒤 페이지 혼합으로 설명되는 정도가 이 값보다 작으면 페이드 잔상 (0이면 판정 끔)
    fade_max_sec: float = 2.0    # 이 시간보다 오래 정지한 구간은 페이드일 수 없으므로 판정하지 않음
    median: bool = True          # 구간 내 프레임 픽셀별 중앙값으로 커서 제거 (False면 가장 선명한 1프레임)
    small_width: int = 320       # 비교용 축소 폭


@dataclass
class Segment:
    index: int
    t_start: float
    t_end: float
    image: np.ndarray  # BGR 크롭 이미지
    faded: bool = False  # 페이드 전환 중간 프레임으로 보여 제외 대상으로 표시됨


# --------------------------------------------------------------------------- #
# 입력 유틸
# --------------------------------------------------------------------------- #
def parse_bbox(text: str) -> BBox:
    """'x,y,w,h' 문자열을 (x, y, w, h)로 변환."""
    try:
        x, y, w, h = (int(round(float(v))) for v in text.replace(" ", "").split(","))
    except ValueError as e:
        raise ValueError("bbox는 'x,y,w,h' 형식의 숫자 4개여야 합니다") from e
    if w <= 0 or h <= 0 or x < 0 or y < 0:
        raise ValueError("bbox 값이 올바르지 않습니다 (x,y>=0, w,h>0)")
    return x, y, w, h


def video_info(path: str | Path) -> dict:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise FileNotFoundError(f"영상을 열 수 없습니다: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    info = {
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "fps": fps,
        "frames": frames,
        "duration": (frames / fps) if fps > 0 else 0.0,
    }
    cap.release()
    return info


def iter_samples(
    path: str | Path,
    interval: float,
    start: float = 0.0,
    end: float | None = None,
) -> Iterator[tuple[float, np.ndarray]]:
    """interval초마다 (시각, BGR 프레임)을 순서대로 내보낸다."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise FileNotFoundError(f"영상을 열 수 없습니다: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if start > 0:
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    idx = int(round(start * fps))
    next_t = start
    try:
        while True:
            t = idx / fps
            if end is not None and t > end:
                break
            if t + 1e-9 < next_t:
                if not cap.grab():
                    break
                idx += 1
                continue
            ok, frame = cap.read()
            if not ok:
                break
            yield t, frame
            next_t += interval
            idx += 1
    finally:
        cap.release()


def read_frame(path: str | Path, time_sec: float) -> np.ndarray:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise FileNotFoundError(f"영상을 열 수 없습니다: {path}")
    cap.set(cv2.CAP_PROP_POS_MSEC, time_sec * 1000.0)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise ValueError(f"{time_sec}s 위치의 프레임을 읽을 수 없습니다")
    return frame


# --------------------------------------------------------------------------- #
# 비교 / 품질 지표
# --------------------------------------------------------------------------- #
def _prep_small(crop: np.ndarray, width: int) -> np.ndarray:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    scale = width / gray.shape[1]
    size = (width, max(1, int(round(gray.shape[0] * scale))))
    return cv2.resize(gray, size, interpolation=cv2.INTER_AREA)


def change_score(a: np.ndarray, b: np.ndarray, pix_thr: int = 25) -> float:
    """두 (회색조, 같은 크기) 이미지의 변화 점수. 0 = 동일, 1 = 완전히 다름.

    '변한 픽셀이 충분히 많이 몰려 있는 가로 열(column)의 비율'.
      - 악보가 바뀌면 음표가 가로 전체에 흩어져 있어 많은 열이 변한다 (수십 %)
      - 얇은 재생 커서/하이라이트는 몇 개 열만 건드린다 (수 %)
      - 페이드/밝기 변화는 거의 모든 열이 변한다
      - 압축 노이즈는 한 열에 변한 픽셀이 몇 개 안 되므로 걸러진다
    """
    changed = cv2.absdiff(a, b) > pix_thr
    min_rows = max(2, int(0.05 * changed.shape[0]))
    return float((changed.sum(axis=0) >= min_rows).mean())


def _blend_ratio(prev: np.ndarray, cur: np.ndarray, nxt: np.ndarray) -> float:
    """cur(회색조)가 앞뒤 페이지의 알파 혼합으로 얼마나 잘 설명되는지.

    작을수록(0에 가까울수록) 크로스페이드 중간 프레임, 1 근처면 독립된 페이지.
    악보 밀도와 무관하다: 성긴 페이지든 빽빽한 페이지든 '이웃의 혼합'은 아니다.
    앞뒤가 사실상 같으면 섞임을 구분할 수 없으므로 1.0(판정 불가 = 페이지로 취급).
    """
    P, X, N = (a.astype(np.float32) for a in (prev, cur, nxt))
    d = P - N
    if float(np.abs(d).mean()) < 2.0:
        return 1.0
    alpha = float(np.clip(((X - N) * d).sum() / (d * d).sum(), 0.0, 1.0))
    err_blend = float(np.abs(X - (alpha * P + (1.0 - alpha) * N)).mean())
    err_min = min(float(np.abs(X - P).mean()), float(np.abs(X - N).mean()))
    return err_blend / max(err_min, 1e-6)


def _sharpness(crop: np.ndarray) -> float:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


# --------------------------------------------------------------------------- #
# 구간 추출
# --------------------------------------------------------------------------- #
_MAX_KEEP = 16  # 구간당 중앙값 계산용으로 보관할 최대 크롭 수 (메모리 상한)


class _Run:
    """한 악보가 정지해 있는 구간. 대표 이미지는 구간 내 프레임의 픽셀별 중앙값.

    움직이는 재생 커서/하이라이트는 프레임마다 위치가 달라 중앙값에서 사라진다.
    """

    def __init__(self, t: float, crop: np.ndarray, small: np.ndarray):
        self.t_start = self.t_end = t
        self.n = 0
        self.anchor = small
        self.crops: list[np.ndarray] = []
        self._stride = 1
        self.best = crop
        self.best_sharp = -1.0
        self.add(t, crop)

    def add(self, t: float, crop: np.ndarray) -> None:
        self.t_end = t
        sharp = _sharpness(crop)
        if sharp > self.best_sharp:  # 폴백용: 가장 선명한 단일 프레임
            self.best, self.best_sharp = crop.copy(), sharp
        if self.n % self._stride == 0:
            self.crops.append(crop.copy())
            if len(self.crops) > _MAX_KEEP:
                self.crops = self.crops[::2]
                self._stride *= 2
        self.n += 1

    def image(self, use_median: bool) -> np.ndarray:
        if use_median and len(self.crops) >= 3:
            return np.median(np.stack(self.crops), axis=0).astype(np.uint8)
        return self.best


def extract_segments(
    video: str | Path,
    bbox: BBox,
    params: Params | None = None,
    start: float = 0.0,
    end: float | None = None,
    debug_rows: list | None = None,
    progress: Callable[[float], None] | None = None,
    keep_faded: bool = False,
) -> list[Segment]:
    """영상에서 bbox 영역의 '안정된 악보 조각'들을 시간순으로 반환.

    페이드 전환 중간 프레임으로 보이는 조각은 기본적으로 뺀다. keep_faded=True면 faded=True로 표시해 함께 돌려주므로
    호출하는 쪽이 사용자에게 보여 주고 선택하게 할 수 있다 (조용히 사라지는 조각이 없도록).
    """
    p = params or Params()
    x, y, w, h = bbox
    info = video_info(video)
    if x + w > info["width"] or y + h > info["height"]:
        raise ValueError(
            f"bbox({x},{y},{w},{h})가 영상 크기({info['width']}x{info['height']})를 벗어납니다"
        )

    candidates: list[_Run] = []
    run: _Run | None = None
    prev_small: np.ndarray | None = None

    def close(r: _Run | None) -> None:
        if r is not None and r.n >= p.min_run:
            candidates.append(r)

    for t, frame in iter_samples(video, p.interval, start, end):
        crop = frame[y : y + h, x : x + w]
        small = _prep_small(crop, p.small_width)

        if run is None:
            run = _Run(t, crop, small)
        else:
            s_prev = change_score(prev_small, small, p.pix_thr)
            s_anchor = change_score(run.anchor, small, p.pix_thr)
            if debug_rows is not None:
                debug_rows.append((round(t, 3), round(s_prev, 4), round(s_anchor, 4)))
            if s_prev <= p.stable_thr and s_anchor <= p.anchor_thr:
                run.add(t, crop)
            else:
                close(run)
                run = _Run(t, crop, small)
        prev_small = small

        if progress and info["duration"] > 0:
            progress(min(t / info["duration"], 1.0))
    close(run)

    # 직전 악보와 같으면 병합 (같은 악보가 커서/노이즈 때문에 둘로 쪼개진 경우)
    merged: list[tuple[float, float, np.ndarray, np.ndarray]] = []
    for r in candidates:
        img = r.image(p.median)
        small = _prep_small(img, p.small_width)
        if merged and change_score(merged[-1][3], small, p.pix_thr) <= p.dedupe_thr:
            t0, _, kept, sm = merged[-1]
            merged[-1] = (t0, r.t_end, kept, sm)
        else:
            merged.append((r.t_start, r.t_end, img, small))

    if not merged:
        return []

    # 페이드 잔상 판정: '짧게' 정지했고, 앞뒤 페이지의 혼합으로 설명되는 후보만.
    # 길게 정지한 구간(예: 성긴 악보가 오래 반복되는 페이지)은 페이드일 수 없으므로 절대 건드리지 않는다.
    segments: list[Segment] = []
    for i, (t0, t1, img, small) in enumerate(merged):
        faded = False
        short = (t1 - t0 + p.interval) <= p.fade_max_sec
        if p.fade_ratio > 0 and short and 0 < i < len(merged) - 1:
            faded = _blend_ratio(merged[i - 1][3], small, merged[i + 1][3]) < p.fade_ratio
        if faded and not keep_faded:
            continue
        segments.append(Segment(len(segments) + 1, t0, t1, img, faded))
    return segments


# --------------------------------------------------------------------------- #
# 출력
# --------------------------------------------------------------------------- #
def save_segments(segments: list[Segment], out_dir: str | Path) -> list[Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for s in segments:
        p = out / f"seg_{s.index:03d}_t{s.t_start:07.2f}{'_faded' if s.faded else ''}.png"
        cv2.imwrite(str(p), s.image)
        paths.append(p)
    return paths


def _to_pil(bgr: np.ndarray) -> Image.Image:
    return Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))


def build_sheet(
    images: list[np.ndarray],
    out_path: str | Path,
    fmt: str = "pdf",
    page_size: tuple[int, int] = (1654, 2339),  # A4 @ 200dpi
    margin: int = 80,
    gap: int = 40,
    max_upscale: float = 3.0,
    jpg_quality: int = 92,
) -> list[Path]:
    """악보 조각들을 A4 페이지에 위에서 아래로 쌓아 PDF(1개) 또는 JPG(페이지별)로 저장.

    out_path는 확장자 없이 줄기(stem)만 써도 되고, 있으면 fmt에 맞게 교체된다.
    """
    if fmt not in ("pdf", "jpg"):
        raise ValueError("fmt는 'pdf' 또는 'jpg'")
    if not images:
        raise ValueError("악보 조각이 없습니다")

    pw, ph = page_size
    cw, chh = pw - 2 * margin, ph - 2 * margin

    pages: list[Image.Image] = []
    page = Image.new("RGB", page_size, "white")
    cur_y = margin
    placed_on_page = 0

    for bgr in images:
        im = _to_pil(bgr)
        scale = min(cw / im.width, max_upscale)
        if im.height * scale > chh:
            scale = chh / im.height
        nw, nh = max(1, round(im.width * scale)), max(1, round(im.height * scale))
        im = im.resize((nw, nh), Image.LANCZOS)

        if placed_on_page and cur_y + nh > ph - margin:
            pages.append(page)
            page = Image.new("RGB", page_size, "white")
            cur_y, placed_on_page = margin, 0

        page.paste(im, ((pw - nw) // 2, cur_y))
        cur_y += nh + gap
        placed_on_page += 1
    pages.append(page)

    base = Path(out_path)
    if fmt == "pdf":
        dest = base.with_suffix(".pdf")
        dest.parent.mkdir(parents=True, exist_ok=True)
        pages[0].save(dest, "PDF", resolution=200.0, save_all=True, append_images=pages[1:])
        return [dest]

    dest_dir = base.parent
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = base.stem
    paths = []
    for i, pg in enumerate(pages, 1):
        pth = dest_dir / f"{stem}_p{i:02d}.jpg"
        pg.save(pth, "JPEG", quality=jpg_quality)
        paths.append(pth)
    return paths
