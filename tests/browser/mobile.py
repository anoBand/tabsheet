"""휴대폰 화면 검증 (Pixel 7 에뮬레이션, 터치 입력).
안내 배너, 폴더 버튼 숨김, 손가락으로 영역 지정·모서리 조절, 물음표 탭, 공유 시트 저장, 추출 완료를 확인한다.
사용: python tests/browser/mobile.py VIDEO [SCREENSHOT_DIR]"""
import http.server, sys, threading
from functools import partial
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]
h = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "docs")); h.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h); threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
shots = Path(sys.argv[2]) if len(sys.argv) > 2 else None
ok = True
def check(n, c, e=""):
    global ok; ok &= bool(c); print("OK  " if c else "FAIL", n, e)

# 공유 시트 흉내: 넘겨받은 파일 이름을 기록. window.__shareMode = 'deny' 이면 권한 만료 오류를 낸다.
SHARE_STUB = """
window.__shared = [];
navigator.canShare = (d) => !!(d && d.files && d.files.length);
navigator.share = async (d) => {
  if (window.__shareMode === 'deny') { window.__shareMode = ''; throw new DOMException('no activation', 'NotAllowedError'); }
  window.__shared.push(d.files.map((f) => f.name + ':' + f.type + ':' + f.size));
};
"""

def touch_drag(cdp, x0, y0, x1, y1, steps=8):
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    for i in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / steps, "y": y0 + (y1 - y0) * i / steps}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(**p.devices["Pixel 7"])
    ctx.add_init_script(SHARE_STUB)
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    check("터치 기기로 인식", pg.evaluate("window.__tabsheet.touch"))
    check("모바일 안내 배너 표시", pg.is_visible("#mobileNote") and "PC" in pg.inner_text("#mobileNote"))
    check("폴더 선택 버튼 숨김", pg.is_hidden("#folderBtn"))
    check("파일 놓기 문구 대신 탭 안내", pg.is_visible("text=탭해서 영상 선택") and not pg.is_visible("text=영상 파일을 여기에 놓으세요"))
    check("가로 스크롤 없음", pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    if shots: pg.screenshot(path=str(shots / "m_home.png"))
    pg.tap("#mobileNoteClose")
    check("배너 닫기", pg.is_hidden("#mobileNote"))
    pg.reload()
    check("닫은 배너는 다시 안 뜸", pg.is_hidden("#mobileNote"))

    pg.set_input_files("#file", sys.argv[1]); pg.wait_for_function("document.getElementById('video').videoWidth > 0", timeout=20000)
    pg.wait_for_function("document.getElementById('video').readyState >= 2")
    cdp = ctx.new_cdp_session(pg)
    pg.evaluate("document.getElementById('vwrap').scrollIntoView({block:'center'})")
    r = pg.eval_on_selector("#video", "v => { const r = v.getBoundingClientRect(); return [r.left, r.top, r.width, r.height, v.videoWidth] }")
    k = r[2] / r[4]
    touch_drag(cdp, r[0] + 100 * k, r[1] + 200 * k, r[0] + 900 * k, r[1] + 500 * k)
    bb = pg.evaluate("window.__tabsheet.st.bbox")
    check("손가락 드래그로 영역 지정", bb and abs(bb["x"] - 100) < 8 and abs(bb["w"] - 800) < 12, str(bb))
    # 오른쪽 아래 모서리 점을 손가락으로 끌어 크기만 조절 (왼쪽 위는 그대로)
    cx, cy = r[0] + (bb["x"] + bb["w"]) * k + 6, r[1] + (bb["y"] + bb["h"]) * k + 6  # 손가락은 점에서 조금 빗나가도 잡혀야 함
    touch_drag(cdp, cx, cy, cx + 200 * k, cy + 100 * k)
    b2 = pg.evaluate("window.__tabsheet.st.bbox")
    check("모서리 끌어 크기 조절 (시작점 유지)", b2["x"] == bb["x"] and b2["y"] == bb["y"] and b2["w"] > bb["w"] + 150 and b2["h"] > bb["h"] + 70, f"{bb} -> {b2}")
    # 위쪽 변만 끌기
    tx, ty = r[0] + (b2["x"] + b2["w"] / 2) * k, r[1] + b2["y"] * k
    touch_drag(cdp, tx, ty, tx, ty + 60 * k)
    b3 = pg.evaluate("window.__tabsheet.st.bbox")
    check("위쪽 변 끌기 (가로는 그대로)", b3["x"] == b2["x"] and b3["w"] == b2["w"] and b3["y"] > b2["y"] + 40, f"{b2} -> {b3}")
    if shots: pg.screenshot(path=str(shots / "m_select.png"))
    pg.tap("#fullWidth")
    b4 = pg.evaluate("window.__tabsheet.st.bbox")
    check("가로 전체", b4["x"] == 0 and b4["w"] == r[4] and b4["y"] == b3["y"] and b4["h"] == b3["h"], str(b4))

    # 물음표: 탭으로 열고 닫기, 체크박스는 바뀌지 않아야 함
    pg.tap("summary")
    tip = "#pMedian ~ .tip"
    pg.tap(tip); pg.wait_for_timeout(250)
    vis = pg.evaluate("getComputedStyle(document.querySelector('#pMedian ~ .tip'), '::after').visibility")
    check("물음표 탭하면 설명 표시", vis == "visible")
    check("물음표 탭이 체크박스를 바꾸지 않음", pg.is_checked("#pMedian"))
    if shots: pg.screenshot(path=str(shots / "m_tip.png"))
    pg.tap(tip); pg.wait_for_timeout(250)
    vis = pg.evaluate("getComputedStyle(document.querySelector('#pMedian ~ .tip'), '::after').visibility")
    check("다시 탭하면 닫힘", vis == "hidden", vis)
    pg.tap(".tip >> nth=0"); pg.wait_for_timeout(100)
    check("입력칸 옆 물음표 탭이 입력칸으로 포커스를 옮기지 않음", pg.evaluate("document.activeElement.classList.contains('tip')"))

    # 추출 (짧은 구간)
    pg.evaluate("window.__tabsheet.setBBox(0, 640, 1920, 380)")
    pg.fill("#pStart", "0:30"); pg.fill("#pEnd", "0:40"); pg.tap("#run")
    pg.wait_for_function("document.getElementById('runStatus').textContent.startsWith('완료')", timeout=90000)
    n = pg.evaluate("window.__tabsheet.st.segs.length")
    check("모바일에서 추출 완료", n >= 1, str(n))

    # 저장: 공유 시트로 넘김
    pg.tap("#mkPdf"); pg.wait_for_function("window.__shared.length === 1", timeout=20000)
    sh = pg.evaluate("window.__shared[0]")
    check("PDF는 공유 시트로 (파일 1개)", len(sh) == 1 and sh[0].endswith(tuple("0123456789")) and ":application/pdf:" in sh[0], str(sh))
    pg.tap("#mkJpg"); pg.wait_for_function("window.__shared.length === 2", timeout=20000)
    sh = pg.evaluate("window.__shared[1]")
    check("JPG는 페이지 수만큼 한 번에 공유", len(sh) >= 1 and all(":image/jpeg:" in s for s in sh), str(sh))
    # 만드는 동안 탭 권한이 만료된 경우: 저장 버튼이 나타나고 누르면 공유
    pg.evaluate("window.__shareMode = 'deny'")
    pg.tap("#mkPdf"); pg.wait_for_selector("#shareBtn", state="visible", timeout=20000)
    check("권한 만료 시 저장 버튼 표시", "버튼" in pg.inner_text("#outStatus"), pg.inner_text("#outStatus"))
    pg.tap("#shareBtn"); pg.wait_for_function("window.__shared.length === 3", timeout=5000)
    check("저장 버튼으로 공유", pg.is_hidden("#shareBtn"))
    if shots: pg.screenshot(path=str(shots / "m_results.png"))
    check("JS 오류 없음", not errs, str(errs))
    b.close()
sys.exit(0 if ok else 1)
