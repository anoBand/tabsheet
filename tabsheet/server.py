"""로컬 웹 GUI 서버 (표준 라이브러리 http.server만 사용, 추가 의존성 없음).

  tabsheet gui            # http://127.0.0.1:8765 에서 열림

API
  POST /api/upload/start   {name, size}                 -> {upload}
  POST /api/upload/chunk   ?upload=&offset= 본문=조각    -> {received}   (순서대로, 재전송 안전)
  POST /api/upload/finish  {upload}                     -> {id, name, info}
  GET  /api/media          (--media-dir 켰을 때)          -> {enabled, files}
  POST /api/open           {name} (media-dir 안의 상대경로) -> {id, name, info}
  GET  /api/frame    ?id=&t=                              -> JPEG
  POST /api/extract  {id, bbox:[x,y,w,h], params, start, end} -> {job}
  GET  /api/job      ?job=                                -> {status, progress, segments, error}
  GET  /api/seg      ?job=&i=                             -> PNG
  POST /api/build    {job, include:[...], format}         -> {files:[{name,url}]}
  GET  /api/file     ?job=&name=                          -> PDF/JPG

보안: 127.0.0.1에만 바인딩하고, 모든 id는 서버가 발급한 값만 허용하며 파일 경로는 사용자 입력으로 만들지 않는다.
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import cv2

from . import core

WEB_DIR = Path(__file__).parent / "web"
ID_RE = re.compile(r"^[0-9a-f]{12}$")
FILE_RE = re.compile(r"^sheet(_p\d{2})?\.(pdf|jpg)$")
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
MAX_UPLOAD = 8 * 1024**3
MAX_CHUNK = 64 * 1024**2  # 조각 하나의 서버 쪽 상한 (실제 조각 크기는 브라우저가 정함)

# GUI에서 바꿀 수 있는 파라미터와 타입
PARAM_TYPES = {
    "interval": float,
    "pix_thr": int,
    "stable_thr": float,
    "anchor_thr": float,
    "min_run": int,
    "dedupe_thr": float,
    "contrast_ratio": float,
    "median": bool,
}


class State:
    def __init__(self, workdir: Path, media_dir: Path | None = None):
        self.workdir = workdir
        self.media_dir = media_dir.resolve() if media_dir else None  # 서버 폴더 열기 허용 범위
        self.videos: dict[str, dict] = {}
        self.jobs: dict[str, dict] = {}
        self.uploads: dict[str, dict] = {}
        (workdir / "uploads").mkdir(parents=True, exist_ok=True)
        (workdir / "jobs").mkdir(parents=True, exist_ok=True)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _run_job(state: State, job_id: str) -> None:
    job = state.jobs[job_id]
    try:

        def progress(frac: float) -> None:
            job["progress"] = round(frac, 3)

        segs = core.extract_segments(
            job["video_path"], job["bbox"], job["params"], job["start"], job["end"], None, progress
        )
        if not segs:
            raise ValueError(
                "악보 조각을 찾지 못했습니다. 영역이 악보를 포함하는지 확인하거나, 세부 설정에서 '같은 악보로 볼 기준'을 올려 보세요."
            )
        paths = core.save_segments(segs, job["dir"] / "segments")
        job["segments"] = [
            {"index": s.index, "t_start": round(s.t_start, 2), "t_end": round(s.t_end, 2), "file": p.name}
            for s, p in zip(segs, paths)
        ]
        job["progress"] = 1.0
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001 - 사용자에게 그대로 전달
        job["status"] = "error"
        job["error"] = str(e)


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        server_version = "tabsheet"

        # --- 응답 도우미 -------------------------------------------------
        def log_message(self, fmt, *args):  # 조용히
            pass

        def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code: int = 200) -> None:
            self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

        def _err(self, code: int, msg: str) -> None:
            self._json({"error": msg}, code)

        def _body_json(self) -> dict:
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > 1_000_000:
                raise ValueError("요청 본문이 올바르지 않습니다")
            return json.loads(self.rfile.read(n))

        # --- 라우팅 ----------------------------------------------------
        def do_GET(self):
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                if url.path in ("/", "/index.html"):
                    html = (WEB_DIR / "index.html").read_bytes()
                    return self._send(200, html, "text/html; charset=utf-8")
                if url.path == "/api/media":
                    return self._media_list()
                if url.path == "/api/frame":
                    return self._frame(q)
                if url.path == "/api/job":
                    return self._job(q)
                if url.path == "/api/seg":
                    return self._seg(q)
                if url.path == "/api/file":
                    return self._file(q)
                self._err(404, "찾을 수 없습니다")
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:  # noqa: BLE001
                self._err(500, str(e))

        def do_POST(self):
            url = urlparse(self.path)
            try:
                if url.path == "/api/upload/start":
                    return self._upload_start()
                if url.path == "/api/upload/chunk":
                    return self._upload_chunk({k: v[0] for k, v in parse_qs(url.query).items()})
                if url.path == "/api/upload/finish":
                    return self._upload_finish()
                if url.path == "/api/open":
                    return self._open_media()
                if url.path == "/api/extract":
                    return self._extract()
                if url.path == "/api/build":
                    return self._build()
                self._err(404, "찾을 수 없습니다")
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
                self._err(400, str(e) or "잘못된 요청입니다")
            except Exception as e:  # noqa: BLE001
                self._err(500, str(e))

        # --- 영상 열기: 청크 업로드 / 서버 폴더 ------------------------------
        def _register_video(self, path: Path, name: str) -> dict:
            info = core.video_info(path)  # 못 열면 FileNotFoundError
            if info["width"] <= 0 or info["frames"] <= 0:
                raise FileNotFoundError("영상을 읽을 수 없습니다. mp4, mov, mkv, webm 형식인지 확인해 주세요.")
            vid = _new_id()
            state.videos[vid] = {"path": path, "info": info, "name": name}
            return {"id": vid, "name": name, "info": info}

        def _get_upload(self, uid: str) -> dict:
            if not ID_RE.match(uid or "") or uid not in state.uploads:
                raise ValueError("업로드 세션을 찾을 수 없습니다. 영상을 다시 선택해 주세요.")
            return state.uploads[uid]

        def _upload_start(self) -> None:
            data = self._body_json()
            size = int(data["size"])
            if size <= 0 or size > MAX_UPLOAD:
                raise ValueError("영상 파일이 비어 있거나 너무 큽니다 (최대 8GB)")
            name = Path(str(data.get("name") or "video.mp4")).name
            ext = Path(name).suffix.lower()
            if ext not in VIDEO_EXTS:
                ext = ".mp4"
            uid = _new_id()
            d = state.workdir / "uploads" / uid
            d.mkdir(parents=True)
            path = d / f"video{ext}"
            path.touch()
            state.uploads[uid] = {"path": path, "name": name, "size": size, "lock": threading.Lock()}
            self._json({"upload": uid})

        def _upload_chunk(self, q: dict) -> None:
            """파일 끝에 조각을 이어 붙인다. 재전송(offset이 이미 받은 위치보다 앞)은 무시하고 현재 크기만 알려준다."""
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > MAX_CHUNK:
                return self._err(413, "조각 크기가 올바르지 않습니다")
            body = self.rfile.read(n)  # 오류 응답 전에 본문을 먼저 다 읽는다
            if len(body) != n:
                raise ValueError("조각이 중간에 끊겼습니다")
            up = self._get_upload(q.get("upload", ""))
            offset = int(q.get("offset", -1))
            with up["lock"]:
                cur = up["path"].stat().st_size
                if offset < 0 or offset > cur:
                    raise ValueError("조각 순서가 맞지 않습니다. 영상을 다시 올려 주세요.")
                if offset == cur:
                    if cur + n > up["size"]:
                        raise ValueError("올리기로 한 크기보다 많은 데이터가 왔습니다")
                    with open(up["path"], "ab") as f:
                        f.write(body)
                    cur += n
            self._json({"received": cur})

        def _upload_finish(self) -> None:
            up = self._get_upload(self._body_json().get("upload", ""))
            uid = next(k for k, v in state.uploads.items() if v is up)
            with up["lock"]:
                got = up["path"].stat().st_size
            if got != up["size"]:
                raise ValueError(f"업로드가 덜 끝났습니다 ({got}/{up['size']} 바이트). 다시 시도해 주세요.")
            try:
                res = self._register_video(up["path"], up["name"])
            except FileNotFoundError as e:
                shutil.rmtree(up["path"].parent, ignore_errors=True)
                state.uploads.pop(uid, None)
                raise ValueError(str(e)) from e
            state.uploads.pop(uid, None)
            self._json(res)

        def _media_list(self) -> None:
            root = state.media_dir
            if root is None:
                return self._json({"enabled": False, "files": []})
            files = []
            for p in sorted(root.rglob("*")):
                if p.suffix.lower() in VIDEO_EXTS and p.is_file() and p.resolve().is_relative_to(root):
                    files.append({"name": p.relative_to(root).as_posix(), "size": p.stat().st_size})
                    if len(files) >= 500:
                        break
            self._json({"enabled": True, "dir": root.name, "files": files})

        def _open_media(self) -> None:
            root = state.media_dir
            if root is None:
                raise ValueError("서버 폴더 열기가 꺼져 있습니다. tabsheet gui --media-dir 폴더 로 실행해 주세요.")
            rel = str(self._body_json().get("name", ""))
            path = (root / rel).resolve()  # '..', 절대 경로, 심볼릭 링크는 resolve 후 root 밖이면 거부
            if not path.is_relative_to(root) or not path.is_file() or path.suffix.lower() not in VIDEO_EXTS:
                raise ValueError("이 폴더에서 영상을 찾을 수 없습니다")
            try:
                res = self._register_video(path, path.name)
            except FileNotFoundError as e:
                raise ValueError(str(e)) from e
            self._json(res)

        # --- 프레임 ---------------------------------------------------------
        def _video(self, vid: str) -> dict:
            if not ID_RE.match(vid or "") or vid not in state.videos:
                raise KeyError("영상을 찾을 수 없습니다. 다시 열어 주세요.")
            return state.videos[vid]

        def _frame(self, q: dict) -> None:
            v = self._video(q.get("id", ""))
            t = max(0.0, min(float(q.get("t", 0)), max(v["info"]["duration"] - 0.05, 0.0)))
            frame = core.read_frame(v["path"], t)
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
            if not ok:
                return self._err(500, "프레임을 인코딩하지 못했습니다")
            self._send(200, buf.tobytes(), "image/jpeg")

        # --- 추출 -------------------------------------------------------
        def _extract(self) -> None:
            data = self._body_json()
            v = self._video(data.get("id", ""))
            x, y, w, h = (int(round(float(n))) for n in data["bbox"])
            info = v["info"]
            if w < 8 or h < 8 or x < 0 or y < 0 or x + w > info["width"] or y + h > info["height"]:
                raise ValueError("악보 영역이 올바르지 않습니다. 프레임 위에서 영역을 다시 지정해 주세요.")

            params = core.Params()
            for key, val in (data.get("params") or {}).items():
                if key in PARAM_TYPES and val is not None:
                    setattr(params, key, PARAM_TYPES[key](val))
            if not (0.05 <= params.interval <= 10):
                raise ValueError("샘플 간격은 0.05~10초 사이여야 합니다")

            start = float(data.get("start") or 0.0)
            end = data.get("end")
            end = float(end) if end not in (None, "") else None

            job_id = _new_id()
            jdir = state.workdir / "jobs" / job_id
            jdir.mkdir(parents=True)
            state.jobs[job_id] = {
                "status": "running",
                "progress": 0.0,
                "video_path": v["path"],
                "bbox": (x, y, w, h),
                "params": params,
                "start": start,
                "end": end,
                "dir": jdir,
                "segments": [],
                "error": None,
            }
            threading.Thread(target=_run_job, args=(state, job_id), daemon=True).start()
            self._json({"job": job_id})

        def _get_job(self, job_id: str) -> dict:
            if not ID_RE.match(job_id or "") or job_id not in state.jobs:
                raise KeyError("작업을 찾을 수 없습니다")
            return state.jobs[job_id]

        def _job(self, q: dict) -> None:
            job_id = q.get("job", "")
            job = self._get_job(job_id)
            segs = [
                {
                    "index": s["index"],
                    "t_start": s["t_start"],
                    "t_end": s["t_end"],
                    "url": f"/api/seg?job={job_id}&i={s['index']}",
                }
                for s in job["segments"]
            ]
            self._json(
                {"status": job["status"], "progress": job["progress"], "segments": segs, "error": job["error"]}
            )

        def _seg(self, q: dict) -> None:
            job = self._get_job(q.get("job", ""))
            i = int(q.get("i", 0))
            for s in job["segments"]:
                if s["index"] == i:
                    data = (job["dir"] / "segments" / s["file"]).read_bytes()
                    return self._send(200, data, "image/png")
            self._err(404, "조각을 찾을 수 없습니다")

        # --- 출력 -------------------------------------------------------
        def _build(self) -> None:
            data = self._body_json()
            job_id = data.get("job", "")
            job = self._get_job(job_id)
            if job["status"] != "done":
                raise ValueError("추출이 끝난 뒤에 만들 수 있습니다")
            fmt = data.get("format")
            if fmt not in ("pdf", "jpg"):
                raise ValueError("형식은 pdf 또는 jpg여야 합니다")
            wanted = {int(i) for i in data.get("include", [])}
            files = [s for s in job["segments"] if s["index"] in wanted]
            if not files:
                raise ValueError("포함할 악보 조각을 하나 이상 선택해 주세요")

            images = []
            for s in files:
                img = cv2.imread(str(job["dir"] / "segments" / s["file"]))
                if img is not None:
                    images.append(img)

            out_dir = job["dir"] / "out"
            out_dir.mkdir(exist_ok=True)
            for old in out_dir.glob(f"sheet*.{fmt}"):  # 이전 결과(페이지 수가 다를 수 있음) 정리
                old.unlink()
            paths = core.build_sheet(images, out_dir / "sheet", fmt)
            self._json(
                {"files": [{"name": p.name, "url": f"/api/file?job={job_id}&name={p.name}"} for p in paths]}
            )

        def _file(self, q: dict) -> None:
            job = self._get_job(q.get("job", ""))
            name = q.get("name", "")
            if not FILE_RE.match(name):
                return self._err(404, "파일을 찾을 수 없습니다")
            path = job["dir"] / "out" / name
            if not path.exists():
                return self._err(404, "파일을 찾을 수 없습니다")
            ctype = "application/pdf" if name.endswith(".pdf") else "image/jpeg"
            self._send(200, path.read_bytes(), ctype, {"Content-Disposition": f'inline; filename="{name}"'})

    return Handler


def serve(
    host: str = "127.0.0.1",
    port: int = 8765,
    workdir: str | Path | None = None,
    open_browser: bool = True,
    media_dir: str | Path | None = None,
) -> int:
    if media_dir is not None and not Path(media_dir).is_dir():
        raise ValueError(f"--media-dir 폴더가 없습니다: {media_dir}")
    cleanup = workdir is None
    work = Path(tempfile.mkdtemp(prefix="tabsheet_")) if cleanup else Path(workdir)
    work.mkdir(parents=True, exist_ok=True)
    state = State(work, Path(media_dir) if media_dir else None)

    httpd = None
    for p in range(port, port + 20):  # 사용 중이면 다음 포트
        try:
            httpd = ThreadingHTTPServer((host, p), make_handler(state))
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        raise OSError(f"{port}~{port + 19} 포트가 모두 사용 중입니다. --port 로 다른 포트를 지정해 주세요.")

    url = f"http://{host}:{port}"
    print(f"tabsheet GUI: {url}   (종료: Ctrl+C)")
    if state.media_dir:
        print(f"서버 폴더 열기: {state.media_dir}")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
    finally:
        httpd.server_close()
        if cleanup:
            shutil.rmtree(work, ignore_errors=True)
    return 0
