// detect.js — 영상 한 프레임에서 악보 영역을 추정한다 (제안용: 틀리면 사용자가 고친다).
// 악보 = 밝고 무채색인 가로 띠 + 그 안에 화면 폭 대부분을 가로지르는 가는 줄(악보선) 여러 개.

/** @param {Uint8ClampedArray} rgba 프레임 전체  @returns {{x:number,y:number,w:number,h:number}|null} */
export function detectScore(rgba, w, h) {
  // 1) 밝은 무채색 픽셀 비율이 높은 행 = 종이 행
  const paper = (i) => { const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]; return r > 165 && g > 165 && b > 165 && Math.max(r, g, b) - Math.min(r, g, b) < 40; };
  const step = Math.max(1, Math.floor(w / 480));
  const cols = Math.ceil(w / step);
  const rowOk = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0; for (let x = 0, i = y * w * 4; x < w; x += step, i += step * 4) if (paper(i)) c++;
    rowOk[y] = c >= 0.7 * cols ? 1 : 0;
  }
  // 2) 종이 행이 이어진 가장 높은 띠 (악보선·음표 때문에 생기는 짧은 끊김은 허용)
  const tol = Math.max(2, Math.round(h * 0.006));
  let best = null, s = -1, last = -1;
  const close = () => { if (s >= 0 && (!best || last - s > best[1] - best[0])) best = [s, last]; s = -1; };
  for (let y = 0; y < h; y++) {
    if (!rowOk[y]) continue;
    if (s >= 0 && y - last > tol) close();
    if (s < 0) s = y;
    last = y;
  }
  close();
  if (!best || best[1] - best[0] + 1 < 0.08 * h) return null;
  const [y0, y1] = best;
  // 3) 가로 범위: 띠 안에서 대부분 종이인 열
  const colOk = new Uint8Array(w);
  const ystep = Math.max(1, Math.floor((y1 - y0) / 60));
  for (let x = 0; x < w; x++) {
    let c = 0, n = 0; for (let y = y0; y <= y1; y += ystep, n++) if (paper((y * w + x) * 4)) c++;
    colOk[x] = c >= 0.6 * n ? 1 : 0;
  }
  let x0 = 0; while (x0 < w && !colOk[x0]) x0++;
  let x1 = w - 1; while (x1 > x0 && !colOk[x1]) x1--;
  const bw = x1 - x0 + 1;
  if (bw < 0.4 * w) return null;
  // 4) 검증: 띠 안에 가로로 긴 어두운 줄(악보선)이 4개 이상 있어야 악보로 본다
  const gray = (i) => rgba[i] * 0.3 + rgba[i + 1] * 0.59 + rgba[i + 2] * 0.11;
  const sample = []; for (let y = y0; y <= y1; y += ystep) for (let x = x0; x <= x1; x += 16) sample.push(gray((y * w + x) * 4));
  sample.sort((p, q) => p - q);
  const bg = sample[sample.length >> 1];
  let lines = 0, prevLine = -9;
  for (let y = y0; y <= y1; y++) {
    let dark = 0, n = 0;
    for (let x = x0; x <= x1; x += 2, n++) if (gray((y * w + x) * 4) < bg - 15) dark++;
    if (dark >= 0.5 * n) { if (y - prevLine > 1) lines++; prevLine = y; }
  }
  if (lines < 4) return null;
  return { x: x0, y: y0, w: bw, h: y1 - y0 + 1 };
}
