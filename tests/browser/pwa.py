"""설치·오프라인 검증: manifest와 아이콘이 있고, 한 번 연 뒤에는 서버가 꺼져도 화면이 열리며 추출까지 된다.
사용: python tests/browser/pwa.py VIDEO"""
import http.server, json, sys, threading
from functools import partial
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]
h = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs")); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/"
ok = True
def check(n, c, e=""):
    global ok; ok &= bool(c); print("OK  " if c else "FAIL", n, e)
m = json.loads((ROOT / "docs/manifest.webmanifest").read_text(encoding="utf-8"))
check("manifest 필수 항목", all(k in m for k in ("name", "start_url", "display", "icons")) and all((ROOT / "docs" / i["src"]).exists() for i in m["icons"]))
sw = (ROOT / "docs/sw.js").read_text(encoding="utf-8")
mods = sorted(p.name for p in (ROOT / "docs").glob("*.js") if p.name != "sw.js")
check("모든 앱 파일이 오프라인 보관 목록에 있음", all(f"'{n}'" in sw for n in mods), str([n for n in mods if f"'{n}'" not in sw]))
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1280, "height": 900}); pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_function("navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true)", timeout=15000)
    pg.wait_for_function("caches.open('tabsheet-v1').then(c => c.keys()).then(k => k.length >= 10)", timeout=15000)
    pg.reload(); pg.wait_for_function("!!navigator.serviceWorker.controller", timeout=15000)
    ctx.set_offline(True); srv.shutdown(); srv.server_close()
    pg.reload()
    check("오프라인에서 화면 열림", pg.is_visible("#pick") and pg.evaluate("!!window.__tabsheet"))
    pg.set_input_files("#file", sys.argv[1]); pg.wait_for_function("document.getElementById('video').readyState >= 2", timeout=20000)
    pg.evaluate("window.__tabsheet.setBBox(0, 640, 1920, 380)")
    pg.fill("#pStart", "30"); pg.fill("#pEnd", "36"); pg.click("#run")
    pg.wait_for_function("document.getElementById('runStatus').textContent.startsWith('완료')", timeout=60000)
    check("오프라인에서 추출 완료", pg.evaluate("window.__tabsheet.st.segs.length") >= 1)
    check("JS 오류 없음", not errs, str(errs))
    b.close()
sys.exit(0 if ok else 1)
