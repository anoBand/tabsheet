"""성긴(음표가 적은) 페이지가 오래 정지하는 테스트 영상을 만든다. 사용: python tests/tools/sparse.py OUT.mp4  (opencv-python-headless, numpy, ffmpeg 필요)

실제 사례: 온음표 화음이 반복되는 구간의 페이지가 통째로 빠졌다. 대비(5~95 백분위 차이)는 사실상 잉크 비율이라
잉크가 5% 아래로 내려가는 성긴 페이지가 '흐린 조각'으로 오판되어 제거됐다. 기대 결과: 5페이지 모두 추출, 페이드 판정 없음.
bbox = 0,0,1000,200
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

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


if __name__ == "__main__":
    out = Path(sys.argv[1])
    with tempfile.TemporaryDirectory() as d:
        raw = Path(d) / "raw.mp4"
        pages = render(raw)
        assert ink_fraction(pages[3]) < 0.05 < min(ink_fraction(pages[i]) for i in (1, 2, 4, 5))  # 전제: 성긴 페이지는 정말 잉크가 적다
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", str(out)], check=True)
    print("written", out)
