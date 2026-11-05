"""숨겨진 탭에서의 동작 측정 (헤드풀 Chrome 필요: xvfb-run python tests/browser/hidden.py VIDEO X,Y,W,H)
1) 일시정지 끔: 탭을 숨긴 채로 끝까지 돌려 속도/결과를 확인  2) 일시정지 켬: 숨기면 멈추고 돌아오면 이어서 끝나는지 확인"""
import http.server, sys, threading, time
from functools import partial
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
video, bbox = sys.argv[1], [int(v) for v in sys.argv[2].split(",")]
h = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs")); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
DONE = "document.getElementById('runStatus').textContent.startsWith('완료') || document.getElementById('runStatus').classList.contains('error')"

def hide(p):
    """주의: 가상 화면(Xvfb)에는 창 관리자가 없어 탭이 진짜로 숨겨지지 않는다. 그래서 document.hidden 만 덮어써서
    '앱 코드의 분기'(일시정지/콜백 생략)를 검증한다. 브라우저의 실제 타이머 제한은 재현되지 않으므로 속도는 사용자 PC에서 확인해야 한다."""
    def setv(v):
        p.evaluate("""(v) => { Object.defineProperty(document, 'hidden', {configurable: true, get: () => v});
                              Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => v ? 'hidden' : 'visible'});
                              document.dispatchEvent(new Event('visibilitychange')); }""", v)
    setv(True); time.sleep(0.5)
    return lambda: setv(False)

def setup(ctx, pause):
    p = ctx.new_page(); p.goto(url); p.set_input_files("#file", video)
    p.wait_for_function("document.getElementById('info').textContent.length > 0", timeout=20000)
    p.evaluate(f"window.__tabsheet.setBBox({bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]})")
    p.evaluate(f"document.getElementById('pauseHidden').checked = {str(pause).lower()}")
    return p

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path="/usr/bin/google-chrome", headless=False, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1280, "height": 900})

    # 1) 일시정지 끔 + 탭 숨김
    p = setup(ctx, False)
    p.click("#run"); time.sleep(1)
    show = hide(p)
    print("hidden(시뮬레이션):", p.evaluate("document.hidden"))
    t0 = time.time()
    p.wait_for_function(DONE, timeout=900000)
    print("[숨김·일시정지 끔]", p.inner_text("#runStatus"), "|", p.inner_text("#timing").splitlines()[:3], f"벽시계 {time.time()-t0:.1f}s(숨김 후)")
    print("   조각 수:", p.evaluate("window.__tabsheet.st.segs.filter(s => !s.faded).length"))
    p.close()

    # 2) 일시정지 켬: 숨기면 멈추고 복귀하면 완료
    p = setup(ctx, True)
    p.click("#run"); time.sleep(1)
    show = hide(p); time.sleep(4)
    print("[일시정지 켬] hidden:", p.evaluate("document.hidden"), "| 숨김 중 상태:", p.inner_text("#runStatus"))
    show(); time.sleep(1); p.wait_for_function(DONE, timeout=900000)
    print("[일시정지 켬] 복귀 후:", p.inner_text("#runStatus"), "| 조각 수:", p.evaluate("window.__tabsheet.st.segs.filter(s => !s.faded).length"))
    b.close()
