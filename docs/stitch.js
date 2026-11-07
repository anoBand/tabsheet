// stitch.js — 가로로 스크롤되는 악보 영상의 "겹침 정리".
//
// 커서를 따라 화면이 넘어가는 영상은 연속한 조각이 서로 겹친다 (앞 조각의 오른쪽 = 다음 조각의 왼쪽).
// 그래서 조각마다 오른쪽 끝 마디가 잘리고, 다음 조각 왼쪽에 같은 마디가 중복된다.
//   1) 연속한 두 조각의 가로 이동량(겹침 위치)을 찾는다
//   2) 겹치는 조각들을 하나의 긴 띠로 이어 붙인다
//   3) 띠에서 마디선을 찾아, 마디선에서만 줄을 나눈다 -> 모든 줄이 온전한 마디로 시작하고 끝난다
// 확신이 없는 쌍은 이어 붙이지 않는다 (마디가 사라지는 것보다 중복이 남는 편이 낫다).
// 겹침이 없는 영상(페이드/컷으로 페이지가 통째로 바뀌는 유형)에서는 아무것도 바꾸지 않는다.

export const STITCH_DEFAULTS = {
  minOverlap: 0.10,   // 겹침이 조각 폭의 이 비율 미만이면 후보에서 제외
  strongThr: 60,      // 밝기 차이가 이 값보다 크면 '확실히 다른 픽셀'
  ratioStrict: 0.15,  // 단독으로 확정하려면 (다른 픽셀 수 / 잉크 픽셀 수)가 이 이하여야 함
  uniqueFactor: 3,    // 단독 확정 시 2등 후보(다른 이동량)보다 이 배수 이상 좋아야 함
  ratioNoPrior: 0.05, // 일정한 이동량(기준)이 없을 때는 이 이하로 아주 잘 맞는 쌍만 인정
  ratioPrior: 0.6,    // 다른 쌍들의 일정한 이동량 근처 후보를 받아들이는 상한
  candidates: 10,     // 열 분포에서 뽑는 후보 수
  barFrac: 0.85,      // 마디선: 악보선 구간 높이의 이 비율 이상이 어두운 열
};

// 코드명(Bsus2/F# 등)은 마디선보다 조금 왼쪽에서 시작하는 경우가 있어, 다음 줄의 코드명이 잘리지 않도록 코드명 띠에만 왼쪽 여유를 둔다.
const LABEL_LEAD = 18, LABEL_TAIL = 14, LABEL_GAP = 16;

const tick = () => new Promise((r) => {
  const c = new MessageChannel();
  c.port1.onmessage = () => { c.port1.close(); r(); };
  c.port2.postMessage(0);
});

function gray(img) {
  const { rgba, w, h } = img, g = new Int16Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + 8192) >> 14;
  return g;
}

/** 열별 잉크량(어두울수록 큼). */
function profile(g, w, h) {
  const p = new Float64Array(w);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) p[x] += 255 - g[i];
  return p;
}

/** b[x] = a[x + s] 가 되는 s 후보들 (열 분포 차이의 지역 최소값). */
function profileCandidates(pa, pb, w, K, minOv) {
  let mean = 0; for (let x = 0; x < w; x++) mean += pa[x]; mean = Math.max(mean / w, 1);
  const smax = Math.floor(w * (1 - minOv));
  const d = new Float64Array(smax + 1);
  for (let s = 0; s <= smax; s++) {
    const ov = w - s; let acc = 0;
    for (let x = 0; x < ov; x++) acc += Math.abs(pa[s + x] - pb[x]);
    d[s] = acc / ov / mean;
  }
  const idx = [];
  for (let s = 1; s < smax; s++) if (d[s] <= d[s - 1] && d[s] <= d[s + 1]) idx.push(s);
  idx.sort((i, j) => d[i] - d[j]);
  return idx.slice(0, K);
}

/** 이동량 s에서 겹친 영역의 (확실히 다른 픽셀 수) / (잉크 픽셀 수). 작을수록 같은 화면. */
function mismatch(a, b, w, h, s, thr, step = 1) {
  const ov = w - s; let n = 0, ink = 0;
  for (let y = 0; y < h; y++) {
    const ra = y * w + s, rb = y * w;
    for (let x = 0; x < ov; x += step) {
      const va = a[ra + x], vb = b[rb + x];
      const diff = va - vb;
      if (diff > thr || diff < -thr) n++;
      if (va < 128 || vb < 128) ink++;
    }
  }
  return { ratio: n / Math.max(ink, 1), n, ink, ov };
}

/** 두 조각의 후보 이동량을 점수순으로 돌려준다 (각 후보는 ±3픽셀 미세 조정). */
function evalPair(a, b, w, h, pa, pb, o) {
  const cs = profileCandidates(pa, pb, w, o.candidates, o.minOverlap);
  const coarse = cs.map((s) => ({ s, r: mismatch(a, b, w, h, s, o.strongThr, 2).ratio })).sort((x, y) => x.r - y.r);
  const out = [];
  coarse.forEach((c, k) => {
    let best = null;
    const range = k < 4 ? 3 : 0; // 상위 후보만 미세 조정
    for (let t = c.s - range; t <= c.s + range; t++) {
      if (t < 0 || w - t < Math.floor(o.minOverlap * w)) continue;
      const m = mismatch(a, b, w, h, t, o.strongThr, 1);
      if (!best || m.ratio < best.ratio) best = { ratio: m.ratio, shift: t, overlap: m.ov };
    }
    if (best) out.push(best);
  });
  out.sort((x, y) => x.ratio - y.ratio);
  return out;
}

const median = (arr) => { const s = [...arr].sort((x, y) => x - y), m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** 단독으로 확정할 수 있는 후보인가: 충분히 잘 맞고, 다른 이동량의 2등보다 훨씬 좋다. */
function standsAlone(cs, o) {
  if (!cs.length) return null;
  const b = cs[0], rest = cs.find((c) => Math.abs(c.shift - b.shift) > 8);
  if (b.ratio <= o.ratioStrict && (!rest || rest.ratio >= o.uniqueFactor * Math.max(b.ratio, 0.01))) return b;
  return null;
}

/** 연속 조각 사이의 이동량을 정한다.
 *  1) 단독 확정 쌍들의 이동량이 일정하면(페이지를 넘기는 거리는 보통 일정) 그 값을 기준으로 삼고
 *  2) 반복 마디 때문에 단독 확정이 안 되는 쌍은 기준 근처 후보 중에서 고른다. */
export async function estimateShifts(images, opts = {}, onProgress) {
  const o = { ...STITCH_DEFAULTS, ...opts };
  const n = images.length;
  if (n < 2) return { shifts: [], prior: null, pairs: [] };
  const { w, h } = images[0];
  const grays = images.map(gray), profs = grays.map((g) => profile(g, w, h));
  const pairs = [];
  for (let i = 0; i < n - 1; i++) {
    if (images[i + 1].w !== w || images[i + 1].h !== h) pairs.push([]);
    else pairs.push(evalPair(grays[i], grays[i + 1], w, h, profs[i], profs[i + 1], o));
    if (onProgress) onProgress((i + 1) / (n - 1));
    await tick();
  }
  const strict = pairs.map((cs) => standsAlone(cs, o)).filter(Boolean).map((c) => c.shift);
  let prior = null;
  if (strict.length >= 2) {
    const m = median(strict), close = strict.filter((s) => Math.abs(s - m) <= 0.03 * w);
    if (close.length >= 2) prior = Math.round(median(close));
  }
  const tol = Math.max(6, 0.01 * w);
  const shifts = pairs.map((cs) => {
    let pick = null;
    if (prior != null) {
      const near = cs.filter((c) => Math.abs(c.shift - prior) <= tol && c.ratio <= o.ratioPrior);
      if (near.length) pick = near.reduce((p, c) => (c.ratio < p.ratio ? c : p));
    }
    if (!pick) { pick = standsAlone(cs, o); if (pick && prior == null && pick.ratio > o.ratioNoPrior) pick = null; }
    return pick ? pick.shift : null;
  });
  return { shifts, prior, pairs };
}

// ---------------------------------------------------------------- 띠 만들기 / 마디선 / 줄 나누기
/** 이동량 목록으로 겹치는 조각들을 하나의 RGBA 띠로 합친다. 겹침의 한가운데에서 앞/뒤 조각을 바꾼다. */
export function composeStrip(images, shifts) {
  const { w, h } = images[0];
  const offs = [0]; shifts.forEach((s) => offs.push(offs[offs.length - 1] + s));
  const total = offs[offs.length - 1] + w;
  const rgba = new Uint8ClampedArray(total * h * 4);
  images.forEach((img, i) => {
    const x0 = offs[i];
    const lo = i === 0 ? x0 : Math.floor((offs[i] + offs[i - 1] + w) / 2);
    for (let y = 0; y < h; y++) {
      const src = (y * w + (lo - x0)) * 4, dst = (y * total + lo) * 4, len = (x0 + w - lo) * 4;
      rgba.set(img.rgba.subarray(src, src + len), dst);
    }
  });
  return { rgba, w: total, h, offs };
}

/** 띠에서 마디선 열 위치를 찾는다. 악보선(가로 줄)이 많은 마지막 묶음(타브)의 세로 구간 전체가 어두운 열. */
export function findBarlines(strip, o = STITCH_DEFAULTS) {
  const { rgba, w, h } = strip;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + 8192) >> 14;
  const sample = []; for (let i = 0; i < g.length; i += 97) sample.push(g[i]);
  const bg = median(sample);
  const rowsDark = new Int32Array(h);
  for (let y = 0; y < h; y++) { let c = 0; for (let x = 0; x < w; x++) if (g[y * w + x] < bg - 18) c++; rowsDark[y] = c; }
  const rows = []; for (let y = 0; y < h; y++) if (rowsDark[y] >= 0.5 * w) rows.push(y);
  if (rows.length < 3) return null;
  const groups = [[rows[0]]];
  for (let k = 1; k < rows.length; k++) (rows[k] - groups[groups.length - 1].at(-1) <= 28 ? groups[groups.length - 1].push(rows[k]) : groups.push([rows[k]]));
  const tab = groups.at(-1), r0 = tab[0], r1 = tab.at(-1), staffTop = groups[0][0];
  if (r1 - r0 < 20) return null;
  const bars = []; let cluster = [];
  for (let x = 0; x < w; x++) {
    let c = 0; for (let y = r0; y <= r1; y++) if (g[y * w + x] < bg - 40) c++;
    if (c >= o.barFrac * (r1 - r0 + 1)) {
      if (cluster.length && x - cluster.at(-1) > 6) { bars.push(Math.round(cluster.reduce((a, b) => a + b, 0) / cluster.length)); cluster = []; }
      cluster.push(x);
    }
  }
  if (cluster.length) bars.push(Math.round(cluster.reduce((a, b) => a + b, 0) / cluster.length));
  return { bars, r0, r1, staffTop };
}

/** 마디선 위치만 사용해 줄을 정한다. 한 줄의 폭(왼쪽 여유 포함)은 maxW 이하.
 *  반환: [{x: 시작 마디선(첫 줄은 0), e: 끝 마디선(마지막 줄은 null), hard: 마디선이 없어 억지로 자른 줄}] */
export function reflow(totalW, bars, maxW, minFrac = 0.25) {
  const out = []; let x = 0;
  const sorted = [...bars].sort((a, b) => a - b);
  while (x < totalW - 1) {
    const lim = x + maxW - 2 * LABEL_LEAD - 8;   // 본문을 가운데 둬도 코드명 띠(왼쪽으로 LABEL_LEAD 더 넓음)가 캔버스를 벗어나지 않게
    if (lim >= totalW) { out.push({ x, e: null, hard: false }); break; }
    const cand = sorted.filter((b) => b > x + minFrac * maxW && b <= lim);
    if (!cand.length) { out.push({ x, e: lim, hard: true }); x = lim; continue; } // 마디선이 없으면 그냥 자름
    const e = cand.at(-1);
    out.push({ x, e, hard: false }); x = e;
  }
  return out;
}

function bgColor(strip) {
  const { rgba, w } = strip, vals = [[], [], []];
  for (let x = 0; x < w; x += 7) for (let c = 0; c < 3; c++) vals[c].push(rgba[x * 4 + c]); // 맨 윗줄
  return vals.map((v) => Math.round(median(v)));
}

/** 한 줄을 만든다. 본문은 마디선(-4 ~ +4)까지, 코드명 띠(악보 위쪽)는 왼쪽으로 LABEL_LEAD만큼 더 넓게 가져오고
 *  오른쪽 끝에서는 다음 마디의 코드명이 잘려 보이지 않도록 LABEL_TAIL만큼 비운다. 줄은 가운데 정렬한다. */
function cropRow(strip, r, outW, bg, labelBottom) {
  const { rgba, w, h } = strip;
  const first = r.x === 0, last = r.e == null;
  const bodyA = first ? 0 : r.x - 4, bodyB = last ? w : r.e + 4;
  const bandA = first ? 0 : r.x - LABEL_LEAD, bandB = last || r.hard ? bodyB : r.e - LABEL_TAIL;
  const bodyW = bodyB - bodyA;
  const out = new Uint8ClampedArray(outW * h * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = 255; }
  const pad0 = Math.max(0, Math.floor((outW - bodyW) / 2)), pad = first ? pad0 : Math.max(pad0, LABEL_LEAD); // 본문(마디선~마디선)을 가운데에 둔다
  for (let y = 0; y < h; y++) {
    const [a, b] = y < labelBottom ? [bandA, bandB] : [bodyA, bodyB];
    if (b <= a) continue;
    const src = (y * w + a) * 4, dst = (y * outW + pad + (a - bodyA)) * 4;
    out.set(rgba.subarray(src, src + (b - a) * 4), dst);
  }
  return { rgba: out, pad };
}

/** 자동 적용해도 안전한 결과인가: 페이지를 넘기는 거리가 일정한 '스크롤형' 영상일 때만 true.
 *  페이드/컷으로 페이지가 통째로 바뀌는 영상에서 우연한 겹침으로 마디를 잃지 않도록 하는 안전장치. */
export function looksLikeScroll(info, nSegs) {
  return info.prior != null && info.links >= 2 && info.links >= 0.6 * (nSegs - 1);
}

/** 전체 정리. segs: [{image:{rgba,w,h}, tStart, tEnd}] (시간 순, 사용할 조각만).
 *  반환 rows: 정리된 줄들 [{image, tStart, tEnd, from:[원본 조각 번호], stitched:boolean}] + info. */
export async function tidy(segs, opts = {}, onProgress) {
  const o = { ...STITCH_DEFAULTS, ...opts };
  const info = { prior: null, links: 0, groups: 0, singles: 0, shifts: [] };
  if (segs.length < 2) return { rows: segs.map((s, i) => ({ image: s.image, tStart: s.tStart, tEnd: s.tEnd, from: [i], stitched: false })), info };
  const { shifts, prior } = await estimateShifts(segs.map((s) => s.image), o, (p) => onProgress && onProgress(p * 0.8));
  info.prior = prior; info.shifts = shifts;

  // 이어진 쌍끼리 묶음(group)으로
  const groups = []; let cur = [0];
  for (let i = 0; i < shifts.length; i++) {
    if (shifts[i] != null) cur.push(i + 1); else { groups.push(cur); cur = [i + 1]; }
  }
  groups.push(cur);

  const rows = [];
  let done = 0;
  for (const gp of groups) {
    done++;
    if (onProgress) onProgress(0.8 + 0.2 * done / groups.length);
    const keepOriginals = () => gp.map((i) => ({ image: segs[i].image, tStart: segs[i].tStart, tEnd: segs[i].tEnd, from: [i], stitched: false }));
    if (gp.length === 1) { info.singles++; rows.push(...keepOriginals()); continue; }
    const imgs = gp.map((i) => segs[i].image);
    const sh = gp.slice(0, -1).map((i) => shifts[i]);
    const strip = composeStrip(imgs, sh);
    const bl = findBarlines(strip, o);
    if (!bl || bl.bars.length < 2) { rows.push(...keepOriginals()); continue; } // 마디선을 못 찾으면 원본 유지
    info.groups++; info.links += gp.length - 1;
    const w = imgs[0].w, bg = bgColor(strip);
    await tick();
    const labelBottom = Math.max(0, bl.staffTop - LABEL_GAP);
    for (const r of reflow(strip.w, bl.bars, w)) {
      const a = r.x, b = r.e == null ? strip.w : r.e;
      const covered = gp.filter((_, k) => strip.offs[k] < b && strip.offs[k] + w > a);
      rows.push({
        image: { rgba: cropRow(strip, r, w, bg, labelBottom).rgba, w, h: strip.h },
        tStart: segs[covered[0]].tStart, tEnd: segs[covered.at(-1)].tEnd, from: covered, stitched: true,
      });
    }
  }
  return { rows, info };
}
