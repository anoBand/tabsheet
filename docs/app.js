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
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---------------------------------------------------------------- 1. 영상 열기
function openFile(f) {
  if (!f || st.busy) return;
  if (st.url) URL.revokeObjectURL(st.url);
  st.url = URL.createObjectURL(f);
  st.name = f.name.replace(/^.*\//, '').replace(/\.[^.]+$/, '') || 'sheet';
  st.segs = [];
  $('results').hidden = true;
  clearBBox();
  enable('s2', false); enable('s3', false);
  setStatus($('openStatus'), '영상을 읽는 중…');
  video.src = st.url;
}
video.addEventListener('error', () => {
  if (!video.src) return;
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
  enable('s2', true); enable('s3', true); updateRunState();
});
$('time').addEventListener('input', () => { if (!st.busy) video.currentTime = +$('time').value; });
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

// ---------------------------------------------------------------- 2. 영역 지정 (드래그 + 숫자 입력)
function drawSel() {
  const sel = $('sel');
  if (!st.bbox || !video.videoWidth) { sel.hidden = true; return; }
  const k = video.clientWidth / video.videoWidth, b = st.bbox;
  Object.assign(sel.style, { left: `${b.x * k}px`, top: `${b.y * k}px`, width: `${b.w * k}px`, height: `${b.h * k}px` });
  sel.hidden = false;
}
function syncInputs() {
  const b = st.bbox;
  $('bx').value = b ? b.x : ''; $('by').value = b ? b.y : ''; $('bw').value = b ? b.w : ''; $('bh').value = b ? b.h : '';
}
function updateRunState() {
  const ok = !!(video.videoWidth && st.bbox && st.bbox.w >= 8 && st.bbox.h >= 8);
  $('run').disabled = !ok || st.busy;
  if (st.busy) return;
  if (video.videoWidth && !ok) setStatus($('runStatus'), '먼저 화면에서 악보 영역을 드래그하세요.');
  else if (ok && $('runStatus').textContent.startsWith('먼저')) setStatus($('runStatus'), '');
}
function setBBox(x, y, w, h) {
  const W = video.videoWidth, H = video.videoHeight;
  x = clamp(Math.round(x), 0, W - 1); y = clamp(Math.round(y), 0, H - 1);
  w = clamp(Math.round(w), 1, W - x); h = clamp(Math.round(h), 1, H - y);
  st.bbox = { x, y, w, h };
  drawSel(); syncInputs(); updateRunState();
}
function clearBBox() { st.bbox = null; drawSel(); syncInputs(); updateRunState(); }

let drag = null;
const wrap = $('vwrap');
const toVideo = (e) => {
  const r = video.getBoundingClientRect(), k = video.videoWidth / r.width;
  return [clamp((e.clientX - r.left) * k, 0, video.videoWidth), clamp((e.clientY - r.top) * k, 0, video.videoHeight)];
};
wrap.addEventListener('pointerdown', (e) => { if (st.busy) return; drag = toVideo(e); wrap.setPointerCapture(e.pointerId); });
wrap.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const [x, y] = toVideo(e);
  setBBox(Math.min(x, drag[0]), Math.min(y, drag[1]), Math.abs(x - drag[0]), Math.abs(y - drag[1]));
});
const endDrag = () => {
  if (!drag) return;
  drag = null;
  if (st.bbox && (st.bbox.w < 8 || st.bbox.h < 8)) clearBBox(); // 클릭만 한 경우
};
wrap.addEventListener('pointerup', endDrag);
wrap.addEventListener('pointercancel', endDrag);
['bx', 'by', 'bw', 'bh'].forEach((id) => $(id).addEventListener('change', () => {
  if (!video.videoWidth || st.busy) return;
  const v = ['bx', 'by', 'bw', 'bh'].map((i) => parseInt($(i).value, 10));
  if (v.some(Number.isNaN) || v[2] < 1 || v[3] < 1) return;
  setBBox(...v);
}));
$('clearSel').onclick = () => { if (!st.busy) clearBBox(); };
window.addEventListener('resize', drawSel);

// ---------------------------------------------------------------- 3. 프레임 샘플링 + 추출
/** t초로 이동해 현재 프레임이 준비될 때까지 기다린다. */
function seekTo(t) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${fmtTime(t)} 위치로 이동하지 못했습니다`)), 15000);
    const done = () => { clearTimeout(to); resolve(); };
    // 'seeked' 시점에 이미 현재 프레임이 준비되어 있으므로 바로 그린다 (프레임 콜백을 기다리면 샘플당 약 0.2초를 낭비했고, 결과는 같았다)
    video.addEventListener('seeked', () => {
      if (video.readyState >= 2) return done();
      video.addEventListener('loadeddata', done, { once: true });
    }, { once: true });
    video.currentTime = t;
  });
}

function paramsFromForm() {
  const n = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  return {
    interval: Math.max(0.1, n('pInterval', DEFAULTS.interval)), minRun: Math.max(1, Math.round(n('pMinRun', DEFAULTS.minRun))),
    stableThr: n('pStable', DEFAULTS.stableThr), anchorThr: n('pAnchor', DEFAULTS.anchorThr),
    dedupeThr: n('pDedupe', DEFAULTS.dedupeThr), fadeRatio: n('pFade', DEFAULTS.fadeRatio), median: $('pMedian').checked,
  };
}

async function run() {
  if (!st.bbox || st.busy) return;
  const params = paramsFromForm();
  const start = Math.max(0, parseFloat($('pStart').value) || 0);
  const endV = parseFloat($('pEnd').value);
  const end = endV > 0 ? Math.min(endV, video.duration) : video.duration;
  const ex = new Extractor(params);
  const { x, y, w, h } = st.bbox;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true });

  st.busy = true; st.cancel = false; st.segs = [];
  $('run').disabled = true; $('cancel').hidden = false; $('results').hidden = true;
  const t0 = performance.now();
  try {
    const n = Math.max(1, Math.floor((end - start - 0.05) / params.interval) + 1);
    let pending = null, lastUi = 0;
    for (let i = 0; i < n; i++) {
      if (st.cancel) throw new Error('중단했습니다');
      const t = start + i * params.interval;
      await (pending || seekTo(t));
      pending = null;
      g.drawImage(video, x, y, w, h, 0, 0, w, h);
      const data = g.getImageData(0, 0, w, h).data;
      if (i + 1 < n) { pending = seekTo(start + (i + 1) * params.interval); pending.catch(() => {}); } // 다음 프레임 디코딩을 먼저 시작해 아래 계산과 겹침
      ex.push(t, data, w, h);
      const now = performance.now();
      if (now - lastUi > 250 || i + 1 === n) {  // 화면 갱신은 0.25초에 한 번만
        lastUi = now;
        $('bar').style.width = `${(i + 1) / n * 90}%`;
        setStatus($('runStatus'), `프레임 읽는 중 ${i + 1}/${n} · ${fmtTime(t)} · 남은 시간 약 ${Math.round((now - t0) / 1000 / (i + 1) * (n - i - 1))}초`);
      }
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
    st.busy = false; $('cancel').hidden = true; $('bar').style.width = '0';
    updateRunState();
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
