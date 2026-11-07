"""화면 동작 검증: 드래그/숫자 입력으로 영역 지정, 영역 지우기, 추출 버튼 활성화. 사용: python tests/browser/ui.py VIDEO [SCREENSHOT.png]"""
import http.server, sys, threading
from functools import partial
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]
h = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs")); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
ok = True
def check(n, c, e=""):
    global ok; ok &= bool(c); print("OK  " if c else "FAIL", n, e)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1280, "height": 1000}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html")
    check("영상 열기 전 추출 비활성", pg.is_disabled("#run"))
    pg.set_input_files("#file", sys.argv[1]); pg.wait_for_function("document.getElementById('video').videoWidth > 0", timeout=20000)
    pg.wait_for_function("document.getElementById('video').readyState >= 2")
    check("영역 없으면 안내", "먼저" in pg.inner_text("#runStatus"), pg.inner_text("#runStatus"))
    r = pg.eval_on_selector("#video", "v => { const r = v.getBoundingClientRect(); return [r.left, r.top, r.width, r.height, v.videoWidth] }")
    k = r[2] / r[4]
    pg.mouse.move(r[0] + 100 * k, r[1] + 200 * k); pg.mouse.down(); pg.mouse.move(r[0] + 900 * k, r[1] + 500 * k, steps=6); pg.mouse.up()
    vals = [pg.input_value(i) for i in ("#bx", "#by", "#bw", "#bh")]
    check("드래그 -> 숫자 입력칸 동기화", all(abs(int(v) - e) <= 2 for v, e in zip(vals, (100, 200, 800, 300))), str(vals))
    check("추출 활성", not pg.is_disabled("#run"))
    pg.fill("#bx", "120"); pg.press("#bx", "Tab")
    check("숫자 입력 -> 영역 반영", pg.evaluate("window.__tabsheet.st.bbox.x") == 120)
    pg.click("#clearSel")
    check("영역 지우기", pg.evaluate("window.__tabsheet.st.bbox") is None and pg.is_disabled("#run") and pg.is_hidden("#sel"))
    pg.mouse.click(r[0] + 50, r[1] + 50)
    check("클릭만 하면 영역 없음", pg.evaluate("window.__tabsheet.st.bbox") is None)
    pg.mouse.move(r[0] + 100 * k, r[1] + 200 * k); pg.mouse.down(); pg.mouse.move(r[0] + 900 * k, r[1] + 500 * k, steps=6); pg.mouse.up()
    check("영상 요소가 보임(추출 중 숨기지 않음)", pg.eval_on_selector("#video", "v => getComputedStyle(v).visibility") == "visible")
    # 시간 입력: 분:초 형식 허용, 잘못된 형식은 안내
    pg.fill("#pStart", "abc"); pg.click("#run")
    check("잘못된 시간 형식 안내", "형식" in pg.inner_text("#runStatus"), pg.inner_text("#runStatus"))
    pg.evaluate("window.__tabsheet.setBBox(0, 640, 1920, 380)")
    pg.fill("#pStart", "0:30"); pg.fill("#pEnd", "0:34"); pg.click("#run")
    pg.wait_for_function("document.getElementById('runStatus').textContent.startsWith('완료')", timeout=60000)
    segs = pg.evaluate("window.__tabsheet.st.segs.map(s => [s.tStart, s.tEnd])")
    check("분:초 범위로 추출 (30~34초)", segs and segs[0][0] >= 30 and segs[-1][1] <= 34, str(segs))
    # 물음표 툴팁: 호버하면 보임
    pg.click("summary"); pg.hover(".tip >> nth=2"); pg.wait_for_timeout(250)
    vis = pg.evaluate("(() => { const t = document.querySelectorAll('.tip')[2]; const s = getComputedStyle(t, '::after'); return [s.visibility, s.opacity, t.dataset.tip] })()")
    check("툴팁 호버 시 표시", vis[0] == "visible" and float(vis[1]) > 0.5 and "높음" in vis[2] and "낮음" in vis[2], str(vis))
    if len(sys.argv) > 3: pg.screenshot(path=sys.argv[3])
    check("JS 오류 없음", not errs, str(errs))
    if len(sys.argv) > 2: pg.screenshot(path=sys.argv[2], full_page=True)
    b.close()
sys.exit(0 if ok else 1)
