"""실제 Chrome 에서 브라우저 버전을 돌려 저장된 기대값(tests/browser/expected/<name>.json)과 비교한다.
기대값은 파이썬 구현(v0 기준)에서 뽑은 조각 시간대이며, 파이썬을 제거한 뒤에도 JS 회귀 테스트로 쓴다.
사용: python tests/browser/e2e.py CASES.json   (CASES: [{name, video, bbox:[x,y,w,h], expect}])"""
import http.server, json, sys, threading, time
from functools import partial
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def serve():
    h = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs"))
    h.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def overlap_ok(a, b, tol=1.0):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


def main():
    cases = json.load(open(sys.argv[1]))
    outdir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".")
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    results = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
        for c in cases:
            ctx = b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
            page = ctx.new_page()
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.on("console", lambda m: errs.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
            page.goto(url)
            page.set_input_files("#file", c["video"])
            if c.get("expect") == "error":
                page.wait_for_function("document.getElementById('openStatus').classList.contains('error')", timeout=15000)
                msg = page.inner_text("#openStatus")
                print(f"[{c['name']}] 오류 안내 표시: {msg}")
                results.append((c["name"], bool(msg) and not errs))
                ctx.close(); continue
            page.wait_for_function("document.getElementById('video').videoWidth > 0", timeout=20000)
            x, y, w, h = c["bbox"]
            page.evaluate(f"window.__tabsheet.setBBox({x},{y},{w},{h})")
            t0 = time.time()
            page.click("#run")
            page.wait_for_function("document.getElementById('runStatus').textContent.startsWith('완료') || document.getElementById('runStatus').classList.contains('error')", timeout=600000)
            wall = time.time() - t0
            status = page.inner_text("#runStatus")
            segs = page.evaluate("window.__tabsheet.st.segs.map(s => [s.tStart, s.tEnd, s.faded])")
            pys = [tuple(s) for s in json.load(open(ROOT / "tests/browser/expected" / f"{c['name']}.json"))["segments"]]
            same_n = len(segs) == len(pys)
            same_t = same_n and all(overlap_ok(a, b_) and a[2] == b_[2] for a, b_ in zip(segs, pys))
            nonfaded = sum(1 for s in segs if not s[2])
            exp_ok = c["expect"] is None or nonfaded == c["expect"]
            print(f"[{c['name']}] 브라우저 {nonfaded}개(+페이드 {len(segs) - nonfaded}) / 기대값 {sum(1 for s in pys if not s[2])}개(+페이드 {sum(1 for s in pys if s[2])}) "
                  f"· 시간대 일치={same_t} · 기대={c['expect']} · {wall:.1f}s · 오류={errs}")
            if not same_t:
                print("   JS :", [(round(a, 1), round(b_, 1), f) for a, b_, f in segs])
                print("   기대:", [(round(a, 1), round(b_, 1), f) for a, b_, f in pys])
            results.append((c["name"], same_t and exp_ok and not errs))
            if c.get("pdf"):
                with page.expect_download() as d:
                    page.click("#mkPdf")
                d.value.save_as(str(outdir / f"{c['name']}.pdf"))
                page.screenshot(path=str(outdir / f"{c['name']}.png"), full_page=True)
            ctx.close()
        b.close()
    ok = all(r[1] for r in results)
    print("ALL OK" if ok else "FAILED", results)
    sys.exit(0 if ok else 1)


main()
