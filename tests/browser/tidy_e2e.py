"""마디 정리 검증 (실제 Chrome). 사용: python tests/browser/tidy_e2e.py CASES.json OUTDIR
CASES: [{name, video, bbox, rows: 기대 줄 수 | 0(겹침 없음 -> 그대로)}]"""
import http.server, json, sys, threading
from functools import partial
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]
h = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs")); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
cases = json.load(open(sys.argv[1])); out = Path(sys.argv[2]); ok = True
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for c in cases:
        pg = b.new_page(viewport={"width": 1280, "height": 900}, accept_downloads=True); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html")
        pg.set_input_files("#file", c["video"]); pg.wait_for_function("document.getElementById('video').videoWidth>0")
        pg.evaluate(f"window.__tabsheet.setBBox({','.join(map(str, c['bbox']))})"); pg.click("#run")
        pg.wait_for_function("document.getElementById('runStatus').textContent.startsWith('완료')", timeout=900000)
        pg.wait_for_function("!window.__tabsheet.st.busy", timeout=120000)   # 추출 직후 자동 정리까지 끝날 때까지
        raw = pg.evaluate("window.__tabsheet.st.segs.filter(s => !s.faded).length")
        tidied = pg.evaluate("window.__tabsheet.st.tidied"); n = pg.evaluate("window.__tabsheet.st.shown.length")
        msg = pg.inner_text("#outStatus")
        good = (n == c["rows"] and tidied) if c["rows"] else (not tidied and n == pg.evaluate("window.__tabsheet.st.segs.length"))
        print(f"[{c['name']}] 조각 {raw} -> {'자동 정리 ' + str(n) + '줄' if tidied else '그대로'} (기대 {c['rows'] or '겹침 없음'}) {'OK' if good else 'FAIL'} | {msg} | 오류 {errs}")
        ok &= bool(good) and not errs
        if tidied:
            pg.screenshot(path=str(out / f"{c['name']}_tidy.png"), full_page=True)
            with pg.expect_download() as d: pg.click("#mkPdf")
            d.value.save_as(str(out / f"{c['name']}_tidy.pdf"))
            pg.click("#tidyBtn"); back = pg.evaluate("window.__tabsheet.st.shown.length === window.__tabsheet.st.segs.length && !window.__tabsheet.st.tidied")
            pg.click("#tidyBtn"); pg.wait_for_function("window.__tabsheet.st.tidied", timeout=60000)
            again = pg.evaluate("window.__tabsheet.st.shown.length") == c["rows"]
            print("   되돌리기/다시 정리:", "OK" if back and again else "FAIL"); ok &= back and again
        pg.close()
    b.close()
print("ALL OK" if ok else "FAILED"); sys.exit(0 if ok else 1)
