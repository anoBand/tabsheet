"""명령줄 인터페이스.

  tabsheet info VIDEO
  tabsheet preview VIDEO --time 12 [--bbox x,y,w,h] -o preview.png
  tabsheet extract VIDEO --bbox x,y,w,h -o out_dir [--format pdf|jpg] [--debug]
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

import cv2

from . import core


def _cmd_info(args: argparse.Namespace) -> int:
    info = core.video_info(args.video)
    print(
        f"{info['width']}x{info['height']}  {info['fps']:.2f}fps  "
        f"{info['duration']:.1f}s ({info['frames']} frames)"
    )
    return 0


def _cmd_preview(args: argparse.Namespace) -> int:
    frame = core.read_frame(args.video, args.time)
    h, w = frame.shape[:2]
    if args.bbox:
        x, y, bw, bh = core.parse_bbox(args.bbox)
        cv2.rectangle(frame, (x, y), (x + bw, y + bh), (0, 0, 255), 3)
    if args.grid:  # 100px 눈금: bbox 좌표를 눈으로 읽기 쉽게
        for gx in range(0, w, 100):
            cv2.line(frame, (gx, 0), (gx, h), (0, 255, 0), 1)
            cv2.putText(frame, str(gx), (gx + 3, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1)
        for gy in range(0, h, 100):
            cv2.line(frame, (0, gy), (w, gy), (0, 255, 0), 1)
            cv2.putText(frame, str(gy), (3, gy + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), frame)
    print(f"저장: {out}  (영상 크기 {w}x{h})")
    return 0


def _cmd_extract(args: argparse.Namespace) -> int:
    bbox = core.parse_bbox(args.bbox)
    params = core.Params(
        interval=args.interval,
        pix_thr=args.pix_thr,
        stable_thr=args.stable_thr,
        anchor_thr=args.anchor_thr,
        min_run=args.min_run,
        dedupe_thr=args.dedupe_thr,
        contrast_ratio=args.contrast_ratio,
        median=not args.no_median,
    )
    out_dir = Path(args.output)
    debug_rows: list | None = [] if args.debug else None

    def progress(frac: float) -> None:
        print(f"\r처리 중 {frac * 100:5.1f}%", end="", file=sys.stderr, flush=True)

    segments = core.extract_segments(
        args.video, bbox, params, args.start, args.end, debug_rows, progress
    )
    print(file=sys.stderr)

    if not segments:
        print("악보 조각을 찾지 못했습니다. bbox를 확인하거나 --stable-thr 값을 올려 보세요.")
        return 1

    seg_paths = core.save_segments(segments, out_dir / "segments")
    sheet_paths = core.build_sheet([s.image for s in segments], out_dir / "sheet", args.format)

    if debug_rows is not None:
        dbg = out_dir / "debug_scores.csv"
        with open(dbg, "w", newline="") as f:
            wr = csv.writer(f)
            wr.writerow(["time_sec", "score_vs_prev", "score_vs_anchor"])
            wr.writerows(debug_rows)
        print(f"디버그 점수: {dbg}")

    print(f"악보 조각 {len(segments)}개 -> {out_dir / 'segments'}")
    for s in segments:
        print(f"  #{s.index:03d}  {s.t_start:7.1f}s ~ {s.t_end:7.1f}s  대비 {s.contrast:.0f}")
    for pth in sheet_paths:
        print(f"악보 파일: {pth}")
    return 0


def _cmd_gui(args: argparse.Namespace) -> int:
    from .server import serve

    return serve(args.host, args.port, args.workdir, not args.no_browser)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tabsheet", description="타브 악보 영상 -> 악보 PDF/JPG")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("info", help="영상 크기/길이 확인")
    p.add_argument("video")
    p.set_defaults(fn=_cmd_info)

    p = sub.add_parser("preview", help="특정 시각의 프레임을 저장 (bbox 지정용)")
    p.add_argument("video")
    p.add_argument("--time", type=float, default=0.0)
    p.add_argument("--bbox", help="x,y,w,h — 주면 빨간 사각형으로 표시")
    p.add_argument("--no-grid", dest="grid", action="store_false", help="100px 눈금 끄기")
    p.add_argument("-o", "--output", default="preview.png")
    p.set_defaults(fn=_cmd_preview)

    p = sub.add_parser("extract", help="악보 조각 추출 + PDF/JPG 생성")
    p.add_argument("video")
    p.add_argument("--bbox", required=True, help="악보 영역 x,y,w,h (픽셀)")
    p.add_argument("-o", "--output", default="out")
    p.add_argument("--format", choices=["pdf", "jpg"], default="pdf")
    p.add_argument("--start", type=float, default=0.0)
    p.add_argument("--end", type=float, default=None)
    p.add_argument("--interval", type=float, default=0.5, help="샘플링 간격(초)")
    p.add_argument("--pix-thr", type=int, default=25)
    p.add_argument("--stable-thr", type=float, default=0.10)
    p.add_argument("--anchor-thr", type=float, default=0.20)
    p.add_argument("--min-run", type=int, default=2)
    p.add_argument("--dedupe-thr", type=float, default=0.05)
    p.add_argument("--contrast-ratio", type=float, default=0.8)
    p.add_argument("--no-median", action="store_true", help="커서 제거(중앙값 합성) 끄고 가장 선명한 1프레임 사용")
    p.add_argument("--debug", action="store_true", help="샘플별 변화 점수 CSV 저장 (임계값 튜닝용)")
    p.set_defaults(fn=_cmd_extract)

    p = sub.add_parser("gui", help="웹 GUI 실행 (브라우저에서 영역을 드래그해 지정)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--workdir", help="업로드/결과 저장 폴더 (생략하면 임시 폴더, 종료 시 삭제)")
    p.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    p.set_defaults(fn=_cmd_gui)

    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except (FileNotFoundError, ValueError) as e:
        print(f"오류: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
