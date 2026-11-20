"""영상 폴더 열기 검증: 폴더 선택(webkitdirectory 대체 경로), 페이지를 열 때 videos/ 를 요청하지 않음. 사용: python tests/browser/folder.py SITE_ROOT
SITE_ROOT 에는 docs/ 와 videos/ (sparse.mp4, sub/syn.mp4, notes.txt; 심볼릭 링크는 업로드 입력에서 무시되므로 실제 파일) 가 있어야 한다.
videos/ 는 폴더 선택 입력에 넣을 파일일 뿐, 서버가 목록을 내 주더라도 앱이 읽어 가면 안 된다."""
import http.server, sys, threading
from functools import partial
from playwright.sync_api import sync_playwright

root = sys.argv[1]
h = partial(http.server.SimpleHTTPRequestHandler, directory=root); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"
ok = True
def check(name, cond, extra=""):
    global ok; ok &= bool(cond); print("OK  " if cond else "FAIL", name, extra)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    errs = []
    # 페이지를 열 때 videos/ 를 자동으로 읽지 않아야 함 (실서비스에서 404만 남기던 요청)
    pg = b.new_page(); reqs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("request", lambda r: reqs.append(r.url))
    pg.goto(f"{base}/docs/index.html"); pg.wait_for_load_state("networkidle"); pg.wait_for_timeout(500)
    check("videos/ 요청 없음", not any("/videos" in u for u in reqs), str([u for u in reqs if "/videos" in u]))
    check("목록 상자 숨김, 메시지 없음", pg.is_hidden("#mediaBox") and pg.inner_text("#openStatus") == "")
    # 폴더 선택 대체 경로 (하위 폴더 포함, 영상만)
    pg2 = b.new_page(); pg2.on("pageerror", lambda e: errs.append(str(e))); pg2.goto(f"{base}/docs/index.html")
    pg2.set_input_files("#dirInput", f"{root}/videos")
    opts2 = sorted(pg2.eval_on_selector_all("#mediaSel option", "o => o.map(x => x.textContent)"))
    check("폴더 선택 목록", opts2 == ["videos/sparse.mp4", "videos/sub/syn.mp4"], str(opts2))
    pg2.click("#mediaOpen")
    pg2.wait_for_function("document.getElementById('video').videoWidth > 0", timeout=30000)
    check("폴더 영상 열림", pg2.inner_text("#info") != "", pg2.inner_text("#info"))
    check("JS 오류 없음", not errs, str(errs))
    b.close()
sys.exit(0 if ok else 1)
