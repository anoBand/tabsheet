// app.js — 브라우저 전용 tabsheet. 영상은 업로드되지 않고 <video> 로 직접 디코딩한다.
import { Extractor, DEFAULTS } from './core.js';
import { composePages, buildPdf } from './pdf.js';
import { initMedia } from './media.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const st = { bbox: null, segs: [], busy: false, cancel: false, url: null, name: 'sheet' };

const fmtTime = (s) => { s = Math.round(s * 10) / 10; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const setStatus = (el, msg, err = false) => { el.textContent = msg; el.classList.toggle('error', err); };
const enable = (id, on) => $(id).classList.toggle('off', !on);

// ---------------------------------------------------------------- 영상 열기
function openFile(f) {
  if (!f) return;
  if (st.url) URL.revokeObjectURL(st.url);
  st.url = URL.createObjectURL(f);
  st.name = f.name.replace(/\.[^.]+$/, '') || 'sheet';
  st.bbox = null; st.segs = [];
  $('sel').hidden = true; $('results').hidden = true; $('run').disabled = true;
  enable('s2', false); enable('s3', false);
  setStatus($('openStatus'), '영상을 읽는 중…');
  video.src = st.url;
}
video.addEventListener('error', () => {
  $('vwrap').hidden = true; $('scrub').hidden = true; $('stageHint').hidden = true; $('drop').hidden = false;
  setStatus($('openStatus'),
    '이 브라우저가 재생할 수 없는 영상입니다 (HEVC/H.265, 일부 mkv 등). H.264 mp4로 변환한 뒤 다시 불러오세요.', true);
});
video.addEventListener('loadedmetadata', () => {
  if (!video.videoWidth) return;
  $('drop').hidden = true; $('vwrap').hidden = false; $('scrub').hidden = false; $('stageHint').hidden = false;
  $('time').max = video.duration; $('time').value = Math.min(video.duration / 2, 30);
  video.currentTime = +$('time').value;
  $('info').textContent = `${video.videoWidth}×${video.videoHeight}, ${fmtTime(video.duration)}`;
  setStatus($('openStatus'), '');
  enable('s2', true);
});
$('time').addEventListener('input', () => { video.currentTime = +$('time').value; });
video.addEventListener('seeked', () => { if (!st.busy) $('timeOut').textContent = fmtTime(video.currentTime); });

$('pick').onclick = () => $('file').click();
$('drop').onclick = () => $('file').click();
$('drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('file').click(); };
$('file').onchange = (e) => openFile(e.target.files[0]);
for (const ev of ['dragover', 'dragenter']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('drop').addEventListener(ev, () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });

initMedia({ box: $('mediaBox'), select: $('mediaSel'), openBtn: $('mediaOpen'), serverBtn: $('serverBtn'), folderBtn: $('folderBtn'),
  dirInput: $('dirInput'), onFile: openFile, status: (m, e) => setStatus($('openStatus'), m, e) });

// ---------------------------------------------------------------- 영역 지정
function setBBox(x, y, w, h) {
  const W = video.videoWidth, H = video.videoHeight;
  x = Math.max(0, Math.min(W - 1, Math.round(x))); y = Math.max(0, Math.min(H - 1, Math.round(y)));
  w = Math.max(1, Math.min(W - x, Math.round(w))); h = Math.max(1, Math.min(H - y, Math.round(h)));
  st.bbox = { x, y, w, h };
  const k = video.clientWidth / W, sel = $('sel');
  Object.assign(sel.style, { left: `${x * k}px`, top: `${y * k}px`, width: `${w * k}px`, height: `${h * k}px` });
  sel.hidden = false;
  $('bboxText').textContent = `x=${x}, y=${y}, 너비=${w}, 높이=${h}`;
  enable('s3', true); $('run').disabled = st.busy;
}
let drag = null;
const wrap = $('vwrap');
const toVideo = (e) => { const r = video.getBoundingClientRect(), k = video.videoWidth / r.width; return [(e.clientX - r.left) * k, (e.clientY - r.top) * k]; };
wrap.addEventListener('pointerdown', (e) => { if (st.busy) return; drag = toVideo(e); wrap.setPointerCapture(e.pointerId); });
wrap.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [x, y] = toVideo(e);
  if (Math.abs(x - drag[0]) > 4 && Math.abs(y - drag[1]) > 4) setBBox(Math.min(x, drag[0]), Math.min(y, drag[1]), Math.abs(x - drag[0]), Math.abs(y - drag[1]));
});
wrap.addEventListener('pointerup', () => { drag = null; });
window.addEventListener('resize', () => { if (st.bbox) { const b = st.bbox; setBBox(b.x, b.y, b.w, b.h); } });

// ---------------------------------------------------------------- 프레임 샘플링
/** t초로 이동해 그 프레임이 실제로 화면에 올라올 때까지 기다린다. */
function seekTo(t) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${fmtTime(t)} 위치로 이동하지 못했습니다`)), 15000);
    const done = () => { clearTimeout(to); resolve(); };
    // 'seeked' 시점에 이미 현재 프레임이 준비되어 있으므로 바로 그린다 (requestVideoFrameCallback 대기는 샘플당 약 0.2초를 낭비했고, 결과도 같았다)
    video.addEventListener('seeked', () => {
      if (video.readyState >= 2) return done();
      video.addEventListener('loadeddata', done, { once: true });
    }, { once: true });
    video.currentTime = t;
  });
}

async function run() {
  if (!st.bbox || st.busy) return;
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  const interval = Math.max(0.1, num('interval', DEFAULTS.interval));
  const start = Math.max(0, num('start', 0));
  const end = num('end', 0) > 0 ? Math.min(num('end', 0), video.duration) : video.duration;
  const ex = new Extractor({ interval, fadeRatio: num('fadeRatio', DEFAULTS.fadeRatio) });
  const { x, y, w, h } = st.bbox;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });

  const timing = []; st.timing = timing; $('timing').hidden = true;
  video.style.visibility = 'hidden'; // 추출 중에는 영상을 화면에 그리지 않는다 (프레임이 바뀔 때마다 화면 합성 비용이 듦)
  st.busy = true; st.cancel = false; st.segs = [];
  $('run').disabled = true; $('cancel').hidden = false; $('results').hidden = true;
  const t0 = performance.now();
  try {
    const n = Math.max(1, Math.floor((end - start - 0.05) / interval) + 1);
    let pending = null, lastUi = 0;
    for (let i = 0; i < n; i++) {
      if (st.cancel) throw new Error('중단했습니다');
      if (document.hidden && $('pauseHidden').checked) {          // 숨겨진 탭에서는 브라우저가 느리게 만들므로 돌아올 때까지 기다린다
        setStatus($('runStatus'), `탭이 숨겨져 일시정지했습니다 (${i}/${n}). 이 탭으로 돌아오면 이어서 진행합니다.`);
        await new Promise((r) => { const f = () => { if (!document.hidden || st.cancel) { document.removeEventListener('visibilitychange', f); r(); } }; document.addEventListener('visibilitychange', f); });
        i--; continue;
      }
      const t = start + i * interval;
      const ts = performance.now(), hid = document.hidden;
      await (pending || seekTo(t));
      pending = null;
      g.drawImage(video, x, y, w, h, 0, 0, w, h);
      const data = g.getImageData(0, 0, w, h).data;
      if (i + 1 < n) { pending = seekTo(start + (i + 1) * interval); pending.catch(() => {}); } // 다음 프레임 디코딩을 먼저 시작해, 아래 계산과 겹쳐 진행
      ex.push(t, data, w, h);
      timing.push([performance.now() - ts, hid]);
      const now = performance.now();
      if (now - lastUi > 250 || i + 1 === n) {   // 화면 갱신은 0.25초에 한 번만 (매 샘플 갱신하면 레이아웃 비용이 듦)
        lastUi = now;
        $('bar').style.width = `${(i + 1) / n * 90}%`;
        const el = (now - t0) / 1000;
        setStatus($('runStatus'), `프레임 읽는 중 ${i + 1}/${n} · ${fmtTime(t)} · 남은 시간 약 ${Math.round(el / (i + 1) * (n - i - 1))}초`);
      }
    }
    setStatus($('runStatus'), '조각 정리하는 중…');
    st.segs = await ex.finish({ keepFaded: true, onProgress: (p) => { $('bar').style.width = `${90 + p * 10}%`; } });
    st.debug = ex.debug;
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus($('runStatus'), `완료: ${st.segs.filter((s) => !s.faded).length}개 조각 (${sec}초 걸림)`);
    st.seconds = +sec;
    showTiming(timing, sec);
    renderResults();
  } catch (e) {
    setStatus($('runStatus'), String(e.message || e), true);
  } finally {
    video.style.visibility = '';
    st.busy = false; $('run').disabled = false; $('cancel').hidden = true; $('bar').style.width = '0';
    video.currentTime = +$('time').value;
  }
}
function showTiming(timing, sec) {
  const stat = (arr) => arr.length ? `${arr.length}장, 평균 ${(arr.reduce((a, b) => a + b[0], 0) / arr.length).toFixed(0)}ms` : '없음';
  const vis = timing.filter((x) => !x[1]), hid = timing.filter((x) => x[1]);
  $('timing').textContent = `총 ${sec}초 · 샘플 ${timing.length}장\n보이는 탭: ${stat(vis)}\n숨겨진 탭: ${stat(hid)}\n` + navigator.userAgent;
  $('timing').hidden = false;
}
$('run').onclick = run;
$('cancel').onclick = () => { st.cancel = true; };

// ---------------------------------------------------------------- 결과
function segCanvas(s) {
  const c = document.createElement('canvas'); c.width = s.image.w; c.height = s.image.h;
  c.getContext('2d').putImageData(new ImageData(s.image.rgba, s.image.w, s.image.h), 0, 0);
  return c;
}
function renderResults() {
  const box = $('pieces'); box.replaceChildren();
  st.segs.forEach((s) => {
    s.on = !s.faded;
    const fig = document.createElement('figure'); fig.className = 'piece' + (s.on ? '' : ' skip');
    const c = segCanvas(s); c.style.cssText = 'display:block;width:100%;height:auto;background:#fff';
    s.canvas = c;
    const cap = document.createElement('figcaption');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.on; cb.id = `seg${s.index}`;
    cb.onchange = () => { s.on = cb.checked; fig.classList.toggle('skip', !s.on); };
    s.cb = cb; s.fig = fig;
    const lb = document.createElement('label'); lb.htmlFor = cb.id;
    lb.textContent = `조각 ${s.index}` + (s.faded ? ' · 페이드 잔상으로 의심되어 제외됨' : '');
    const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = `${fmtTime(s.tStart)} – ${fmtTime(s.tEnd)}`;
    cap.append(cb, lb, tm); fig.append(c, cap); box.append(fig);
  });
  $('resTitle').textContent = `추출된 악보 조각 ${st.segs.filter((s) => !s.faded).length}개`;
  $('results').hidden = false;
}
const setAll = (on) => st.segs.forEach((s) => { s.on = on; s.cb.checked = on; s.fig.classList.toggle('skip', !on); });
$('allOn').onclick = () => setAll(true);
$('allOff').onclick = () => setAll(false);

function download(bytes, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function build(fmt) {
  const picked = st.segs.filter((s) => s.on);
  if (!picked.length) { setStatus($('outStatus'), '선택된 조각이 없습니다.', true); return; }
  setStatus($('outStatus'), '만드는 중…');
  const pages = await composePages(picked.map((s) => s.canvas));
  if (fmt === 'pdf') download(buildPdf(pages), `${st.name}.pdf`, 'application/pdf');
  else pages.forEach((p, i) => setTimeout(() => download(p.jpeg, `${st.name}_p${String(i + 1).padStart(2, '0')}.jpg`, 'image/jpeg'), i * 300));
  setStatus($('outStatus'), `${fmt.toUpperCase()} ${pages.length}페이지를 내려받았습니다.`);
  st.lastPages = pages;
}
$('mkPdf').onclick = () => build('pdf');
$('mkJpg').onclick = () => build('jpg');

// 자동 테스트용 훅 (화면 동작에는 영향 없음)
window.__tabsheet = { st, setBBox, run, build };
