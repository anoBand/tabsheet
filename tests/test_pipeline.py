"""합성 영상으로 파이프라인 전체를 검증한다.  실행: python -m pytest tests  (또는 python tests/test_pipeline.py)"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import synthetic  # noqa: E402
from tabsheet import Params, build_sheet, extract_segments  # noqa: E402


def _match_ids(segments, tabs):
    """각 추출 조각이 정답 악보 중 무엇과 가장 비슷한지 (id, 평균 절대 오차) 반환."""
    out = []
    for s in segments:
        g = cv2.cvtColor(s.image, cv2.COLOR_BGR2GRAY).astype(np.float32)
        errs = {}
        for tid, img in tabs.items():
            gt = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
            gt = cv2.resize(gt, (g.shape[1], g.shape[0]))
            errs[tid] = float(np.abs(g - gt).mean())
        best = min(errs, key=errs.get)
        out.append((best, errs[best]))
    return out


def test_full_pipeline(tmp_path):
    video = tmp_path / "synthetic.mp4"
    meta = synthetic.render_video(video)

    segments = extract_segments(video, meta["bbox"], Params())

    # 1) 조각 수와 순서: 컷/페이드/커서가 있어도 정확히 6개, 정답 순서와 일치
    ids = _match_ids(segments, meta["tabs"])
    assert [i for i, _ in ids] == meta["sequence"], f"추출 순서 불일치: {ids}"
    # 2) 각 조각이 정답과 충분히 가까움 (페이드 잔상이 아닌 깨끗한 프레임)
    assert all(err < 12 for _, err in ids), f"조각 품질 낮음: {ids}"
    # 2-1) 재생 커서(빨간 선)가 결과 이미지에 남아 있지 않아야 함
    for s in segments:
        b, g, r = s.image[..., 0].astype(int), s.image[..., 1].astype(int), s.image[..., 2].astype(int)
        red_ratio = float(((r > 180) & (g < 90) & (b < 90)).mean())
        assert red_ratio < 0.0005, f"조각 {s.index}에 커서 잔상 (red={red_ratio:.5f})"

    # 2-2) 3초 슬로우 페이드의 중간 화면은 기본값에서 빠지고, keep_faded=True면 표시된 채로 돌려준다
    with_faded = extract_segments(video, meta["bbox"], Params(), keep_faded=True)
    assert len(with_faded) == len(segments) + 1 and sum(s.faded for s in with_faded) == 1
    assert not any(s.faded for s in segments)

    # 3) 시간 순서 단조 증가
    starts = [s.t_start for s in segments]
    assert starts == sorted(starts)

    # 4) PDF / JPG 출력
    pdf = build_sheet([s.image for s in segments], tmp_path / "sheet", "pdf")
    assert pdf[0].suffix == ".pdf" and pdf[0].stat().st_size > 1000
    jpgs = build_sheet([s.image for s in segments], tmp_path / "sheet", "jpg")
    assert jpgs and all(p.suffix == ".jpg" and p.exists() for p in jpgs)


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        test_full_pipeline(Path(d))
    print("OK")
