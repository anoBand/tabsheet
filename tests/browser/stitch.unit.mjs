// 겹침 정리 단위 테스트 (순수 JS): node tests/browser/stitch.unit.mjs
// 반복되는 마디 + 마디마다 다른 작은 번호가 있는 긴 악보 띠를 만들고, 일정 거리씩 넘어가는 화면으로 잘라 복원해 본다.
import { tidy, composeStrip, estimateShifts, looksLikeScroll } from '../../docs/stitch.js';

let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fail++; };
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const H = 120, MEASURE = 310, N = 24, TOTAL = MEASURE * N + 4;
const strip = new Uint8ClampedArray(TOTAL * H * 4).fill(244);
const put = (x, y, v) => { const i = (y * TOTAL + x) * 4; strip[i] = strip[i + 1] = strip[i + 2] = v; };
for (const y of [30, 45, 60, 75, 90, 105]) for (let x = 0; x < TOTAL; x++) put(x, y, 205);       // 악보선(옅음)
for (let m = 0; m <= N; m++) for (let y = 30; y <= 105; y++) for (let dx = 0; dx < 2; dx++) put(Math.min(TOTAL - 1, m * MEASURE + dx), y, 40); // 마디선
const riff = Array.from({ length: 12 }, () => [Math.floor(rnd() * 250) + 20, 30 + 15 * Math.floor(rnd() * 6)]); // 2마디 주기로 반복할 패턴
for (let m = 0; m < N; m++) {
  riff.forEach(([dx, y], k) => { const x = m * MEASURE + 12 + ((k + (m % 2) * 5) * 24) % 280; for (let a = 0; a < 7; a++) for (let b = 0; b < 7; b++) put(x + a, y - 3 + b, 30); });
  // 코드명 대용: 마디선보다 8픽셀 왼쪽에서 시작해 오른쪽으로 긴 표식 (줄 나눌 때 잘리면 안 됨)
  for (let a = -8; a < 36; a++) for (let b = 0; b < 6; b++) if (m * MEASURE + a >= 0) put(m * MEASURE + a, 6 + b, 50);
  // 마디 번호 대용: 첫 악보선 바로 위, 마디선에 걸쳐 있음 (마디선 -5 ~ +6). 줄을 나눌 때 반쪽만 남으면 안 됨
  for (let a = -5; a <= 6; a++) for (let b = 19; b <= 26; b++) if (m * MEASURE + a >= 0 && (a + b) % 3) put(m * MEASURE + a, b, 60);
  // 마디 번호·코드명 대용: 마디마다 다른 모양의 표식 (실제 악보에서 반복 마디를 구별해 주는 유일한 단서)
  let r = (m + 1) * 2654435761 >>> 0; const nr = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let k = 0; k < 5; k++) { const bx = m * MEASURE + 8 + Math.floor(nr() * 250), by = 6 + Math.floor(nr() * 14); for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) if (nr() > 0.35) put(bx + a, by + b, 50); }
}
const W = 1280, SHIFT = 900;
const views = []; for (let off = 0; off + W <= TOTAL; off += SHIFT) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) rgba.set(strip.subarray((y * TOTAL + off) * 4, (y * TOTAL + off + W) * 4), y * W * 4);
  views.push({ image: { rgba, w: W, h: H }, tStart: views.length, tEnd: views.length + 1, off });
}
const { shifts, prior } = await estimateShifts(views.map((v) => v.image));
check('이동량 복원', shifts.every((s) => s === SHIFT), `${views.length}장, shifts=${shifts.join(',')} prior=${prior}`);
const rec = composeStrip(views.map((v) => v.image), shifts);
let diff = 0, n = 0; for (let i = 0; i < rec.w * H * 4; i += 4) { diff += Math.abs(rec.rgba[i] - strip[(Math.floor(i / 4 / rec.w) * TOTAL + (i / 4) % rec.w) * 4]); n++; }
check('이어 붙인 띠가 원본과 같음', diff / n < 0.01, `평균 차이 ${(diff / n).toFixed(4)}`);
const { rows, info } = await tidy(views);
check('자동 적용 판정: 스크롤형', looksLikeScroll(info, views.length));
check('줄 나누기: 모든 줄이 마디선으로 시작', rows.length >= 2 && info.links === views.length - 1, `${rows.length}줄, links=${info.links}`);
// 독립된 페이지들(겹침 없음)은 절대 이어 붙이지 않는다
const indep = Array.from({ length: 4 }, (_, k) => { const g = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < g.length; i += 4) { const v = rnd() > 0.93 ? 30 : 244; g[i] = g[i + 1] = g[i + 2] = v; g[i + 3] = 255; } return { image: { rgba: g, w: W, h: H }, tStart: k, tEnd: k + 1 }; });
const r2 = await tidy(indep);
check('겹침 없는 페이지는 그대로', r2.info.links === 0 && r2.rows.length === 4, `links=${r2.info.links}`);
check('자동 적용 판정: 겹침 없음은 false', !looksLikeScroll(r2.info, 4));
check('자동 적용 판정: 링크가 1개뿐이면 false', !looksLikeScroll({ prior: 900, links: 1 }, 5));

// 줄 모양: 가운데 정렬(좌우 여백이 비슷), 코드명 띠는 끝에서 잘린 글자가 없고 시작에서 온전함
const inkBand = (img, x) => { for (let y = 2; y < 13; y++) if (img.rgba[(y * img.w + x) * 4] < 120) return true; return false; };
const inkBody = (img, x) => { for (let y = 50; y < 110; y++) if (img.rgba[(y * img.w + x) * 4] < 120) return true; return false; };
let leftAligned = true, labelsOk = true, firstL = null;
rows.forEach((r, i) => {
  const img = r.image; let l = 0; while (l < img.w && !inkBody(img, l)) l++; let rr = img.w - 1; while (rr > 0 && !inkBody(img, rr)) rr--;
  if (firstL === null) firstL = l; else if (Math.abs(l - firstL) > 1 && i < rows.length - 1) leftAligned = false; // 모든 줄의 왼쪽 시작 위치가 같아야 함
  if (i > 0 && i < rows.length - 1) {
    if (inkBand(img, rr - 6)) labelsOk = false;                                  // 오른쪽 끝에 잘린 코드명이 없어야 함
    if (!inkBand(img, l + 6)) labelsOk = false;                                  // 왼쪽 시작의 코드명(마디선보다 왼쪽에서 시작)이 온전히 있어야 함
  }
});
check('모든 줄이 왼쪽 정렬', leftAligned, `첫 줄 왼쪽 여백 ${firstL}`);
check('코드명이 줄 경계에서 잘리지 않음', labelsOk);
// 마디 번호: 각 줄 시작에는 온전히(마디선 왼쪽 부분까지), 끝에는 다음 마디 번호가 조금도 남지 않아야 함
const inkNum = (img, x) => { for (let y = 19; y <= 26; y++) if (img.rgba[(y * img.w + x) * 4] < 120) return true; return false; };
let numStart = true, numEnd = true;
rows.forEach((r, i) => {
  const img = r.image; let l = 0; while (l < img.w && !inkBody(img, l)) l++; let rr = img.w - 1; while (rr > 0 && !inkBody(img, rr)) rr--;
  if (i > 0 && !(inkNum(img, l - 5) && inkNum(img, l + 6))) numStart = false;
  if (i < rows.length - 1) for (let x = rr - 14; x <= Math.min(img.w - 1, rr + 8); x++) if (inkNum(img, x)) numEnd = false;
});
check('마디 번호: 줄 시작에서 온전함', numStart);
check('마디 번호: 줄 끝에 반쪽 번호 없음', numEnd);
process.exit(fail ? 1 : 0);
