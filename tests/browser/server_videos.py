"""서버 videos/ 목록 검증 (개발용 주소 전용). 사용: python tests/browser/server_videos.py SITE_ROOT
SITE_ROOT 에는 docs/ 와 videos/ (sparse.mp4, sub/syn.mp4, notes.txt) 가 있어야 한다.
- 개발용 주소(127.0.0.1)에서는 버튼 없이 목록이 뜨고 서버 영상을 열 수 있어야 한다.
- 실제 사이트 주소(tab.algernon.page)에서는 videos/ 를 요청하지 않고 아무것도 표시하지 않아야 한다."""
import http.server, sys, threading
from functools import partial
from playwright.sync_api import sync_playwright

root = sys.argv[1]
h = partial(http.server.SimpleHTTPRequestHandler, directory=root); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
ok = True
def check(name, cond, extra=""):
    global ok; ok &= bool(cond); print("OK  " if cond else "FAIL", name, extra)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    errs = []
    pg = b.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{port}/docs/index.html")
    pg.wait_for_selector("#mediaBox:not([hidden])", timeout=5000)   # 버튼을 누르지 않아도 자동으로 목록이 나와야 함
    opts = pg.eval_on_selector_all("#mediaSel option", "o => o.map(x => x.textContent)")
    check("개발용 주소: 서버 videos/ 목록 (txt 제외, 하위폴더는 건너뜀)", opts == ["sparse.mp4"], str(opts))
    pg.click("#mediaOpen")
    pg.wait_for_function("document.getElementById('video').videoWidth > 0", timeout=30000)
    check("개발용 주소: 서버 영상 열림", "1000×200" in pg.inner_text("#info"), pg.inner_text("#info"))

    # 실제 사이트 주소(https 고정)로 연 것처럼: 요청을 가로채 이 테스트 서버의 파일로 응답한다
    pg2 = b.new_page(); reqs = []; pg2.on("pageerror", lambda e: errs.append(str(e)))
    pg2.on("request", lambda r: reqs.append(r.url))
    pg2.route("https://tab.algernon.page/**", lambda r: r.fulfill(response=r.fetch(url=r.request.url.replace("https://tab.algernon.page", f"http://127.0.0.1:{port}"))))
    pg2.goto("https://tab.algernon.page/docs/index.html"); pg2.wait_for_load_state("networkidle"); pg2.wait_for_timeout(500)
    check("실제 사이트 주소: 앱이 열림", pg2.is_visible("#pick"))
    check("실제 사이트 주소: videos/ 요청 없음", not any("/videos" in u for u in reqs), str([u for u in reqs if "/videos" in u]))
    check("실제 사이트 주소: 목록 상자 숨김, 메시지 없음", pg2.is_hidden("#mediaBox") and pg2.inner_text("#openStatus") == "")
    check("JS 오류 없음", not errs, str(errs))
    b.close()
sys.exit(0 if ok else 1)
