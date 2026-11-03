// app.js — 브라우저 전용 tabsheet. 영상은 업로드되지 않고 <video> 로 직접 디코딩한다.
import { Extractor, DEFAULTS } from './core.js';
import { composePages, buildPdf } from './pdf.js';

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
    '이 브라우저가 재생할 수 없는 영상입니다 (HEVC/H.265, 일부 mkv 등). H.264 mp4로 변환하거나 파이썬 버전을 사용하세요.', true);
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
    video.addEventListener('seeked', () => {
      if ('requestVideoFrameCallback' in video) {
        let fired = false;
        video.requestVideoFrameCallback(() => { fired = true; done(); });
        setTimeout(() => { if (!fired) done(); }, 250); // 이미 그려진 프레임이면 콜백이 안 올 수 있음
      } else done();
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

  st.busy = true; st.cancel = false; st.segs = [];
  $('run').disabled = true; $('cancel').hidden = false; $('results').hidden = true;
  const t0 = performance.now();
  try {
    const n = Math.max(1, Math.floor((end - start - 0.05) / interval) + 1);
    for (let i = 0; i < n; i++) {
      if (st.cancel) throw new Error('중단했습니다');
      const t = start + i * interval;
      await seekTo(t);
      g.drawImage(video, x, y, w, h, 0, 0, w, h);
      ex.push(t, g.getImageData(0, 0, w, h).data, w, h);
      $('bar').style.width = `${(i + 1) / n * 90}%`;
      const el = (performance.now() - t0) / 1000;
      setStatus($('runStatus'), `프레임 읽는 중 ${i + 1}/${n} · ${fmtTime(t)} · 남은 시간 약 ${Math.round(el / (i + 1) * (n - i - 1))}초`);
    }
    setStatus($('runStatus'), '조각 정리하는 중…');
    st.segs = await ex.finish({ keepFaded: true, onProgress: (p) => { $('bar').style.width = `${90 + p * 10}%`; } });
    st.debug = ex.debug;
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus($('runStatus'), `완료: ${st.segs.filter((s) => !s.faded).length}개 조각 (${sec}초 걸림)`);
    st.seconds = +sec;
    renderResults();
  } catch (e) {
    setStatus($('runStatus'), String(e.message || e), true);
  } finally {
    st.busy = false; $('run').disabled = false; $('cancel').hidden = true; $('bar').style.width = '0';
    video.currentTime = +$('time').value;
  }
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
