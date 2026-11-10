// app.js — 브라우저 전용 tabsheet. 영상은 업로드되지 않고 <video> 로 직접 디코딩한다.
import { Extractor, DEFAULTS } from './core.js';
import { composePages, buildPdf } from './pdf.js';
import { initMedia } from './media.js';
import { tidy, looksLikeScroll } from './stitch.js';
import { parseTime } from './timefmt.js';
import { detectScore } from './detect.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const st = { bbox: null, segs: [], busy: false, cancel: false, url: null, name: 'sheet' };

const fmtTime = (s) => { s = Math.round(s * 10) / 10; const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const setStatus = (el, msg, err = false) => { el.textContent = msg; el.classList.toggle('error', err); };
const enable = (id, on) => $(id).classList.toggle('off', !on);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
/** 손가락이 주 입력인 기기(휴대폰·태블릿). PC 화면 동작은 이 값이 false일 때 그대로 유지된다. */
const touch = matchMedia('(pointer: coarse)').matches;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } } };

// ---------------------------------------------------------------- 모바일 안내
if (touch && store.get('tabsheet.mobileNote') !== 'off') $('mobileNote').hidden = false;
$('mobileNoteClose').onclick = () => { $('mobileNote').hidden = true; store.set('tabsheet.mobileNote', 'off'); };

// 물음표 설명: 탭으로 열고 다시 탭하면 닫힘. label 안에 있어서 그냥 두면 탭이 체크박스를 바꾸거나 입력칸으로 포커스를 옮긴다.
document.querySelectorAll('.tip').forEach((tip) => {
  let wasOpen = false;
  tip.addEventListener('pointerdown', () => { wasOpen = document.activeElement === tip; });
  tip.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (wasOpen) tip.blur(); else tip.focus();
  });
});

// ---------------------------------------------------------------- 1. 영상 열기
function openFile(f) {
  if (!f || st.busy) return;
  if (st.url) URL.revokeObjectURL(st.url);
  st.url = URL.createObjectURL(f);
  st.name = f.name.replace(/^.*\//, '').replace(/\.[^.]+$/, '') || 'sheet';
  st.segs = [];
  $('results').hidden = true;
  clearBBox();
  st.autoOff = false; setStatus($('selStatus'), '');
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
video.addEventListener('seeked', () => { if (!st.busy) { $('timeOut').textContent = fmtTime(video.currentTime); suggestBBox(); } });

/** 아직 영역을 정하지 않았으면 지금 화면에서 악보 영역을 찾아 제안한다. 사용자가 한 번이라도 직접 정하거나 지우면 더 제안하지 않는다. */
function suggestBBox() {
  if (st.bbox || st.autoOff || st.busy || video.readyState < 2 || !video.videoWidth) return;
  try {
    const W = video.videoWidth, H = video.videoHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0);
    const b = detectScore(g.getImageData(0, 0, W, H).data, W, H);
    if (!b) return;
    setBBox(b.x, b.y, b.w, b.h);
    setStatus($('selStatus'), '악보로 보이는 영역을 자동으로 잡았습니다. 맞지 않으면 고쳐 주세요.');
  } catch { /* 제안은 실패해도 무시 */ }
}
const manualSel = () => { st.autoOff = true; setStatus($('selStatus'), ''); };

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

let drag = null;   // 새로 그리기: { mode:'new', x0, y0 } / 크기 조절: { mode:'edge', h, box }
const wrap = $('vwrap');
const toVideo = (e) => {
  const r = video.getBoundingClientRect(), k = video.videoWidth / r.width;
  return [clamp((e.clientX - r.left) * k, 0, video.videoWidth), clamp((e.clientY - r.top) * k, 0, video.videoHeight)];
};
/** 포인터가 선택 상자의 어느 모서리·변 위에 있는지 ('nw','n',... 또는 ''). 손가락은 판정 범위를 넓게 잡는다. */
function edgeAt(e) {
  if (!st.bbox) return '';
  const r = video.getBoundingClientRect(), k = r.width / video.videoWidth, b = st.bbox;
  const px = e.clientX - r.left, py = e.clientY - r.top, tol = e.pointerType === 'mouse' ? 8 : 22;
  const L = b.x * k, T = b.y * k, R = (b.x + b.w) * k, B = (b.y + b.h) * k;
  if (px < L - tol || px > R + tol || py < T - tol || py > B + tol) return '';
  const v = Math.abs(py - T) <= tol ? 'n' : Math.abs(py - B) <= tol ? 's' : '';
  const h = Math.abs(px - L) <= tol ? 'w' : Math.abs(px - R) <= tol ? 'e' : '';
  return v + h;
}
const CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
wrap.addEventListener('pointerdown', (e) => {
  if (st.busy || !video.videoWidth) return;
  manualSel();
  const h = edgeAt(e);
  const [x, y] = toVideo(e);
  drag = h ? { mode: 'edge', h, box: { ...st.bbox } } : { mode: 'new', x0: x, y0: y };
  wrap.setPointerCapture(e.pointerId);
});
wrap.addEventListener('pointermove', (e) => {
  if (!drag) { if (e.pointerType === 'mouse' && !st.busy) wrap.style.cursor = CURSOR[edgeAt(e)] || ''; return; }
  const [x, y] = toVideo(e);
  if (drag.mode === 'new') { setBBox(Math.min(x, drag.x0), Math.min(y, drag.y0), Math.abs(x - drag.x0), Math.abs(y - drag.y0)); return; }
  const o = drag.box, h = drag.h;
  let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
  if (h.includes('w')) l = Math.min(x, r - 8);
  if (h.includes('e')) r = Math.max(x, l + 8);
  if (h.includes('n')) t = Math.min(y, b - 8);
  if (h.includes('s')) b = Math.max(y, t + 8);
  setBBox(l, t, r - l, b - t);
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
  manualSel(); setBBox(...v);
}));
$('clearSel').onclick = () => { if (!st.busy) { manualSel(); clearBBox(); } };
$('fullWidth').onclick = () => {
  if (st.busy || !video.videoWidth) return;
  const b = st.bbox || { y: Math.round(video.videoHeight * 0.55), h: Math.round(video.videoHeight * 0.4) };
  setBBox(0, b.y, video.videoWidth, b.h);
};
window.addEventListener('resize', drawSel);

// ---------------------------------------------------------------- 3. 프레임 샘플링 + 추출
/** 진행 중인 이동. 휴대폰에서 다른 앱으로 넘어갔다 오면 이동이 끝나지 않은 채 멈춰 있을 수 있어 다시 요청한다. */
let curSeek = null;
/** t초로 이동해 현재 프레임이 준비될 때까지 기다린다. */
function seekTo(t) {
  return new Promise((resolve, reject) => {
    let tries = 0, to = 0;
    const arm = () => { clearTimeout(to); to = setTimeout(onTimeout, 15000); };
    const finish = () => { clearTimeout(to); video.removeEventListener('seeked', onSeeked); curSeek = null; };
    const done = () => { finish(); resolve(); };
    const onTimeout = () => {
      if (document.hidden) return arm();                 // 화면 밖에서는 기다리기만 한다 (돌아오면 다시 요청)
      if (++tries > 2) { finish(); reject(new Error(`${fmtTime(t)} 위치로 이동하지 못했습니다`)); return; }
      kick();
    };
    // 'seeked' 시점에 이미 현재 프레임이 준비되어 있으므로 바로 그린다 (프레임 콜백을 기다리면 샘플당 약 0.2초를 낭비했고, 결과는 같았다)
    const onSeeked = () => {
      if (video.readyState >= 2) return done();
      video.addEventListener('loadeddata', done, { once: true });
    };
    const kick = () => { arm(); video.currentTime = t; };
    video.addEventListener('seeked', onSeeked);
    curSeek = { kick };
    kick();
  });
}

// 추출 중 화면 꺼짐 방지 (지원 브라우저만; 화면을 벗어나면 자동으로 풀리므로 돌아올 때 다시 요청)
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !document.hidden) { if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } }
    else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !st.busy) return;
  keepAwake(true);
  if (curSeek) curSeek.kick();  // 멈춰 있던 이동을 다시 요청
});

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
  const startV = parseTime($('pStart').value), endV = parseTime($('pEnd').value);
  if (Number.isNaN(startV) || Number.isNaN(endV)) { setStatus($('runStatus'), '시작/끝은 90, 1:30, 1:02:03 같은 형식으로 입력하세요.', true); return; }
  const start = Math.min(startV ?? 0, Math.max(0, video.duration - 0.1));
  const end = endV != null && endV > start ? Math.min(endV, video.duration) : video.duration;
  if (endV != null && endV <= start) { setStatus($('runStatus'), '끝 시간은 시작 시간보다 커야 합니다.', true); return; }
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
    const recent = [];  // 최근 샘플 시각: 남은 시간을 최근 속도로 계산 (앱 전환으로 멈췄던 시간이 계속 반영되지 않게)
    keepAwake(true);
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
      recent.push(now); if (recent.length > 40) recent.shift();
      if (recent.length > 1 && now - recent[recent.length - 2] > 5000) recent.splice(0, recent.length - 1); // 긴 멈춤 이후엔 새로 잰다
      if (now - lastUi > 250 || i + 1 === n) {  // 화면 갱신은 0.25초에 한 번만
        lastUi = now;
        $('bar').style.width = `${(i + 1) / n * 90}%`;
        const per = recent.length > 1 ? (recent[recent.length - 1] - recent[0]) / (recent.length - 1) : (now - t0) / (i + 1);
        setStatus($('runStatus'), `프레임 읽는 중 ${i + 1}/${n} · ${fmtTime(t)} · 남은 시간 약 ${Math.round(per / 1000 * (n - i - 1))}초`);
      }
    }
    setStatus($('runStatus'), '조각 정리하는 중…');
    st.segs = await ex.finish({ keepFaded: true, onProgress: (p) => { $('bar').style.width = `${90 + p * 10}%`; } });
    st.debug = ex.debug;
    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus($('runStatus'), `완료: ${st.segs.filter((s) => !s.faded).length}개 조각 (${sec}초 걸림)`);
    st.seconds = +sec;
    renderResults();
    st.busy = false;
    await runTidy(true); // 스크롤형 영상이면 겹침을 자동으로 정리 (확실하지 않으면 그대로 둠)
  } catch (e) {
    setStatus($('runStatus'), String(e.message || e), true);
  } finally {
    st.busy = false; $('cancel').hidden = true; $('bar').style.width = '0';
    keepAwake(false);
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
function renderResults(list = st.segs, tidied = false) {
  const box = $('pieces'); box.replaceChildren();
  st.shown = list; st.tidied = tidied;
  $('tidyBtn').textContent = tidied ? '원본 조각 보기' : '마디 정리';
  list.forEach((s) => {
    s.on = tidied ? true : !s.faded;
    const fig = document.createElement('figure'); fig.className = 'piece' + (s.on ? '' : ' skip');
    const c = segCanvas(s); c.style.cssText = 'display:block;width:100%;height:auto;background:#fff';
    s.canvas = c;
    const cap = document.createElement('figcaption');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.on; cb.id = `seg${s.index}`;
    cb.onchange = () => { s.on = cb.checked; fig.classList.toggle('skip', !s.on); };
    s.cb = cb; s.fig = fig;
    const lb = document.createElement('label'); lb.htmlFor = cb.id;
    lb.textContent = (tidied ? `줄 ${s.index}` : `조각 ${s.index}`) + (s.faded ? ' · 페이드 잔상으로 의심되어 제외됨' : '');
    const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = `${fmtTime(s.tStart)} – ${fmtTime(s.tEnd)}`;
    cap.append(cb, lb, tm); fig.append(c, cap); box.append(fig);
  });
  $('resTitle').textContent = tidied ? `정리된 악보 ${list.length}줄` : `추출된 악보 조각 ${list.filter((s) => !s.faded).length}개`;
  $('results').hidden = false;
}
const setAll = (on) => st.shown.forEach((s) => { s.on = on; s.cb.checked = on; s.fig.classList.toggle('skip', !on); });
/** 겹침 정리. auto=true(추출 직후 자동)면 스크롤형 영상으로 확실할 때만 적용하고, 아니면 아무것도 바꾸지 않는다. */
async function runTidy(auto) {
  const picked = st.segs.filter((x) => x.on !== false && !x.faded);
  if (picked.length < 2) { if (!auto) setStatus($('outStatus'), '정리하려면 조각을 2개 이상 선택하세요.', true); return false; }
  st.busy = true; $('tidyBtn').disabled = true;
  try {
    const { rows, info } = await tidy(picked, {}, (p) => setStatus($('outStatus'), `겹침 찾는 중… ${Math.round(p * 100)}%`));
    if (auto ? !looksLikeScroll(info, picked.length) : !info.links) {
      setStatus($('outStatus'), auto ? '' : '서로 겹치는 조각을 찾지 못해 그대로 둡니다. (화면이 통째로 바뀌는 영상이면 정상입니다)');
      return false;
    }
    const list = rows.map((r, i) => ({ index: i + 1, tStart: r.tStart, tEnd: r.tEnd, image: r.image, faded: false, from: r.from }));
    renderResults(list, true);
    setStatus($('outStatus'), `${picked.length}조각 → ${list.length}줄로 자동 정리했습니다 (겹침 ${info.links}곳). 틀려 보이면 '원본 조각 보기'로 되돌리세요.`);
    return true;
  } catch (e) {
    setStatus($('outStatus'), auto ? '' : `정리하지 못했습니다: ${e.message || e}`, !auto);
    return false;
  } finally { st.busy = false; $('tidyBtn').disabled = false; }
}
$('tidyBtn').onclick = async () => {
  if (st.busy) return;
  if (st.tidied) { renderResults(st.segs, false); setStatus($('outStatus'), ''); return; }
  await runTidy(false);
};
$('allOn').onclick = () => setAll(true);
$('allOff').onclick = () => setAll(false);

function download(bytes, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
/** 휴대폰에서는 공유 시트(파일에 저장·사진에 저장·다른 앱으로 보내기)로 넘긴다. 성공하면 true. */
async function share(files) {
  try { await navigator.share({ files, title: st.name }); setStatus($('outStatus'), `${files.length}개 파일을 공유 시트로 넘겼습니다.`); }
  catch (e) {
    if (e.name === 'AbortError') { setStatus($('outStatus'), '저장을 취소했습니다. 다시 하려면 아래 버튼을 누르세요.'); $('shareBtn').hidden = false; return; }
    if (e.name === 'NotAllowedError') { setStatus($('outStatus'), '만들었습니다. 아래 버튼을 눌러 저장하세요.'); $('shareBtn').hidden = false; return; } // 만드는 데 시간이 걸려 탭 권한이 만료된 경우
    throw e;
  }
}
async function build(fmt) {
  const picked = st.shown.filter((s) => s.on);
  if (!picked.length) { setStatus($('outStatus'), '선택된 조각이 없습니다.', true); return; }
  $('shareBtn').hidden = true;
  setStatus($('outStatus'), '만드는 중…');
  const pages = await composePages(picked.map((s) => s.canvas));
  st.lastPages = pages;
  const files = fmt === 'pdf'
    ? [new File([buildPdf(pages)], `${st.name}.pdf`, { type: 'application/pdf' })]
    : pages.map((p, i) => new File([p.jpeg], `${st.name}_p${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
  if (touch && navigator.canShare?.({ files })) {
    st.shareFiles = files;
    try { await share(files); return; } catch { /* 공유 실패 시 아래 내려받기로 */ }
  }
  files.forEach((f, i) => setTimeout(() => download(f, f.name, f.type), i * 300));
  setStatus($('outStatus'), `${fmt.toUpperCase()} ${pages.length}페이지를 내려받았습니다.`);
}
$('shareBtn').onclick = () => { $('shareBtn').hidden = true; if (st.shareFiles) share(st.shareFiles).catch((e) => setStatus($('outStatus'), `저장하지 못했습니다: ${e.message || e}`, true)); };
$('mkPdf').onclick = () => build('pdf');
$('mkJpg').onclick = () => build('jpg');

// 홈 화면 설치·오프라인 사용 (https 또는 localhost에서만 동작, 실패해도 앱은 그대로 동작)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// 자동 테스트용 훅 (화면 동작에는 영향 없음)
window.__tabsheet = { st, setBBox, run, build, touch, clearBBox: () => { manualSel(); clearBBox(); } };
