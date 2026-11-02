"""성긴(음표가 적은) 악보 페이지가 오래 정지해 있어도 사라지지 않는지 검증한다.

실제 사례: 온음표 화음이 반복되는 구간(62~77마디)의 페이지가 PDF에서 통째로 빠졌다.
원인은 '대비 필터'였다. 대비(5~95 백분위 차이)는 사실상 잉크 비율을 재는 값이라, 잉크가 5% 아래로 내려가는 성긴 페이지는
빽빽한 페이지들의 중앙값에 비해 '흐린 조각'으로 오판되어 제거됐다.

실행: python -m pytest tests  (또는 python tests/test_sparse.py)
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tabsheet import Params, extract_segments  # noqa: E402

W, H, FPS = 1000, 200, 10
BBOX = (0, 0, W, H)


def make_page(seed: int, n_blocks: int) -> np.ndarray:
    """6줄(1px) + n_blocks개의 14x14 검은 블록(빔/음표 대용). 블록이 많으면 빽빽한 페이지(잉크 6%대), 적으면 성긴 페이지(3%대)."""
    img = np.full((H, W, 3), 245, np.uint8)
    for i in range(6):
        y = 30 + 28 * i
        cv2.line(img, (10, y), (W - 10, y), (40, 40, 40), 1)
    rng = np.random.default_rng(seed)
    xs = rng.choice(np.arange(20, W - 40, 20), size=n_blocks, replace=False)
    for x in xs:
        y = 30 + 28 * int(rng.integers(0, 6)) - 7
        cv2.rectangle(img, (int(x), y), (int(x) + 14, y + 14), (20, 20, 20), -1)
    cv2.putText(img, f"m{seed}", (15, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (90, 90, 90), 1)  # 마디 번호 대용
    return img


def ink_fraction(img: np.ndarray) -> float:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return float((g < np.median(g) - 60).mean())


# (페이지 id, 블록 수, 정지 시간 초, 이 페이지로 들어오는 전환 초: 0이면 컷)
PAGES = [(1, 38, 6, 0.0), (2, 38, 6, 0.0), (3, 3, 17, 1.0), (4, 38, 6, 0.0), (5, 38, 6, 0.0)]


def render(path: Path) -> dict[int, np.ndarray]:
    pages = {pid: make_page(pid, n) for pid, n, _, _ in PAGES}
    vw = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    rng = np.random.default_rng(7)

    def write(frame):
        noisy = np.clip(frame.astype(np.float32) + rng.normal(0, 1.5, frame.shape), 0, 255).astype(np.uint8)
        vw.write(noisy)

    prev = None
    for pid, _, hold, fade in PAGES:
        cur = pages[pid]
        if prev is not None and fade > 0:
            n = int(fade * FPS)
            for k in range(1, n + 1):
                a = k / (n + 1)
                write(cv2.addWeighted(prev, 1 - a, cur, a, 0))
        for _ in range(int(hold * FPS)):
            write(cur)
        prev = cur
    vw.release()
    return pages


def match(segment_img: np.ndarray, pages: dict[int, np.ndarray]) -> tuple[int, float]:
    g = cv2.cvtColor(segment_img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    best = None
    for pid, img in pages.items():
        gt = cv2.cvtColor(cv2.resize(img, (g.shape[1], g.shape[0])), cv2.COLOR_BGR2GRAY).astype(np.float32)
        err = float(np.abs(g - gt).mean())
        if best is None or err < best[1]:
            best = (pid, err)
    return best


def test_sparse_page_is_kept():
    with tempfile.TemporaryDirectory() as d:
        pages = render(Path(d) / "sparse.mp4")
        # 전제: 성긴 페이지는 정말 잉크가 적고, 나머지는 빽빽하다 (실제 영상의 상황 재현)
        assert ink_fraction(pages[3]) < 0.05 < min(ink_fraction(pages[i]) for i in (1, 2, 4, 5))

        segs = extract_segments(Path(d) / "sparse.mp4", BBOX, Params())
        got = [match(s.image, pages) for s in segs]
        assert [pid for pid, _ in got] == [1, 2, 3, 4, 5], f"페이지 순서/누락: {got} (구간 {[(s.t_start, s.t_end) for s in segs]})"
        assert all(err < 10 for _, err in got), f"조각 품질: {got}"
        assert not any(s.faded for s in segs)


def test_blend_ratio_separates_blends_from_pages():
    from tabsheet.core import _blend_ratio

    rng = np.random.default_rng(1)
    P = (rng.random((60, 320)) > 0.9).astype(np.float32) * 200 + 30
    N = (rng.random((60, 320)) > 0.9).astype(np.float32) * 200 + 30
    other = (rng.random((60, 320)) > 0.9).astype(np.float32) * 200 + 30
    blend = 0.4 * P + 0.6 * N
    assert _blend_ratio(P, blend, N) < 0.2          # 앞뒤의 혼합 = 페이드 중간
    assert _blend_ratio(P, other, N) > 0.8          # 독립된 페이지
    assert _blend_ratio(P, P.copy(), P.copy()) == 1.0  # 앞뒤가 같으면 판정 불가 -> 페이지로 취급


if __name__ == "__main__":
    test_sparse_page_is_kept()
    print("sparse page: OK")
    test_blend_ratio_separates_blends_from_pages()
    print("blend ratio: OK")
