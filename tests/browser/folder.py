"""영상 폴더 열기 검증: 서버 videos/ 목록, 폴더 선택(webkitdirectory 대체 경로). 사용: python tests/browser/folder.py SITE_ROOT
SITE_ROOT 에는 docs/ 와 videos/ (sparse.mp4, sub/syn.mp4, notes.txt; 심볼릭 링크는 업로드 입력에서 무시되므로 실제 파일) 가 있어야 한다."""
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
    pg = b.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"{base}/docs/index.html")
    pg.click("#serverBtn")
    opts = pg.eval_on_selector_all("#mediaSel option", "o => o.map(x => x.textContent)")
    check("서버 videos/ 목록 (txt 제외, 하위폴더는 건너뜀)", opts == ["sparse.mp4"], str(opts))
    pg.click("#mediaOpen")
    pg.wait_for_function("document.getElementById('info').textContent.length > 0", timeout=30000)
    check("서버 영상 열림", "1000×200" in pg.inner_text("#info"), pg.inner_text("#info"))
    # 폴더 선택 대체 경로 (하위 폴더 포함, 영상만)
    pg2 = b.new_page(); pg2.on("pageerror", lambda e: errs.append(str(e))); pg2.goto(f"{base}/docs/index.html")
    pg2.set_input_files("#dirInput", f"{root}/videos")
    opts2 = sorted(pg2.eval_on_selector_all("#mediaSel option", "o => o.map(x => x.textContent)"))
    check("폴더 선택 목록", opts2 == ["videos/sparse.mp4", "videos/sub/syn.mp4"], str(opts2))
    pg2.click("#mediaOpen")
    pg2.wait_for_function("document.getElementById('info').textContent.length > 0", timeout=30000)
    check("폴더 영상 열림", pg2.inner_text("#info") != "", pg2.inner_text("#info"))
    # videos/ 가 없는 서버
    pg3 = b.new_page(); pg3.goto(f"{base}/docs/index.html")
    pg3.evaluate("window.fetch = () => Promise.resolve(new Response('', {status: 404}))")
    pg3.click("#serverBtn"); pg3.wait_for_timeout(300)
    check("목록 실패 안내", "읽을 수 없습니다" in pg3.inner_text("#openStatus"))
    check("JS 오류 없음", not errs, str(errs))
    b.close()
sys.exit(0 if ok else 1)
