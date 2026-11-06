"""검증용 합성 영상 생성기.

실제 타브 영상의 어려운 점을 흉내 낸다:
  - 악보는 영상 내 고정 사각형(BBOX)에만 표시, 바깥에는 계속 움직이는 노이즈
  - 전환: 즉시 컷 / 1초 페이드 / 3초 느린 페이드 / 0.6초 페이드
  - 일부 악보 위로 가는 빨간 재생 커서가 지나감
  - 마지막 악보는 첫 악보와 동일 (비연속 반복은 유지되어야 함)
  - H.264 재인코딩으로 압축 노이즈 추가
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1280, 720, 25
BBOX = (140, 440, 1000, 200)  # x, y, w, h

# 악보 id 순서: 마지막은 첫 번째와 같은 악보
SEQUENCE = [0, 1, 2, 3, 4, 0]
# SEQUENCE[i] -> SEQUENCE[i+1] 전환 시간(초). 0 = 즉시 컷
TRANSITIONS = [0.0, 1.0, 3.0, 0.0, 0.6]
HOLD = 4.0                       # 각 악보가 안정적으로 보이는 시간
CURSOR_ON = {0, 1, 2}            # 커서가 지나가는 악보 id


def tab_image(seed: int) -> np.ndarray:
    """흰 배경에 6줄 + 프렛 숫자가 있는 타브 한 줄 (BGR)."""
    rng = np.random.default_rng(seed)
    w, h = BBOX[2], BBOX[3]
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=18)
    ys = [30 + 28 * i for i in range(6)]
    for y in ys:
        d.line([(10, y), (w - 10, y)], fill=(40, 40, 40), width=2)
    for col in range(16):
        x = 30 + col * 60
        for _ in range(rng.integers(1, 4)):
            s = int(rng.integers(0, 6))
            fret = str(int(rng.integers(0, 16)))
            d.rectangle([x - 2, ys[s] - 11, x + 24, ys[s] + 11], fill="white")
            d.text((x, ys[s] - 9), fret, fill=(0, 0, 0), font=font)
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def build_timeline():
    """[(tab_id, stable_start, stable_end)], 총 길이."""
    spans, t = [], 0.0
    for i, tab_id in enumerate(SEQUENCE):
        spans.append((tab_id, t, t + HOLD))
        t += HOLD
        if i < len(TRANSITIONS):
            t += TRANSITIONS[i]
    return spans, t


def render_video(out_path: Path, seed: int = 123) -> dict:
    """영상 파일 생성 후 정답 정보를 반환."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tabs = {i: tab_image(100 + i) for i in set(SEQUENCE)}
    spans, total = build_timeline()
    rng = np.random.default_rng(seed)

    raw = out_path.with_suffix(".raw.mp4")
    vw = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    x0, y0, bw, bh = BBOX
    n_frames = int(total * FPS)

    for f in range(n_frames):
        t = f / FPS
        # 배경: 어두운 그라데이션 + 영역 바깥에서 움직이는 도형 (노이즈)
        frame = np.zeros((H, W, 3), np.uint8)
        frame[:] = (50 + (np.arange(H)[:, None] * 40 // H)).astype(np.uint8)[:, :, None]
        cx = int((t * 150) % W)
        cv2.rectangle(frame, (cx, 60), (cx + 160, 200), (0, 180, 255), -1)
        cv2.circle(frame, (int(W - (t * 90) % W), 330), 40, (255, 120, 0), -1)

        # 현재 시각의 악보 결정
        tab = None
        for i, (tid, a, b) in enumerate(spans):
            if a <= t < b:
                tab = tabs[tid].copy()
                if tid in CURSOR_ON:
                    cxp = int((t - a) / HOLD * (bw - 6)) + 2
                    cv2.line(tab, (cxp, 5), (cxp, bh - 5), (0, 0, 255), 3)
                break
            if i + 1 < len(spans) and b <= t < spans[i + 1][1]:  # 전환 구간
                alpha = (t - b) / (spans[i + 1][1] - b)
                tab = cv2.addWeighted(tabs[tid], 1 - alpha, tabs[spans[i + 1][0]], alpha, 0)
                break
        if tab is not None:
            frame[y0 : y0 + bh, x0 : x0 + bw] = tab

        noise = rng.normal(0, 2.0, frame.shape)
        frame = np.clip(frame.astype(np.float32) + noise, 0, 255).astype(np.uint8)
        vw.write(frame)
    vw.release()

    # H.264 재인코딩으로 압축 열화 추가 (ffmpeg 없으면 원본 사용)
    if shutil.which("ffmpeg"):
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
               "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", str(out_path)]
        if subprocess.run(cmd).returncode == 0:
            raw.unlink()
        else:
            raw.rename(out_path)
    else:
        raw.rename(out_path)

    return {"tabs": tabs, "spans": spans, "sequence": SEQUENCE, "bbox": BBOX, "duration": total}


if __name__ == "__main__":
    import sys

    dest = Path(sys.argv[1] if len(sys.argv) > 1 else "synthetic.mp4")
    meta = render_video(dest)
    print(f"생성: {dest}  길이 {meta['duration']:.1f}s  bbox={','.join(map(str, BBOX))}")
