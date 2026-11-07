// 겹침 정리 단위 테스트 (순수 JS): node tests/browser/stitch.unit.mjs
// 반복되는 마디 + 마디마다 다른 작은 번호가 있는 긴 악보 띠를 만들고, 일정 거리씩 넘어가는 화면으로 잘라 복원해 본다.
import { tidy, composeStrip, estimateShifts } from '../../docs/stitch.js';

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
check('줄 나누기: 모든 줄이 마디선으로 시작', rows.length >= 2 && info.links === views.length - 1, `${rows.length}줄, links=${info.links}`);
// 독립된 페이지들(겹침 없음)은 절대 이어 붙이지 않는다
const indep = Array.from({ length: 4 }, (_, k) => { const g = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < g.length; i += 4) { const v = rnd() > 0.93 ? 30 : 244; g[i] = g[i + 1] = g[i + 2] = v; g[i + 3] = 255; } return { image: { rgba: g, w: W, h: H }, tStart: k, tEnd: k + 1 }; });
const r2 = await tidy(indep);
check('겹침 없는 페이지는 그대로', r2.info.links === 0 && r2.rows.length === 4, `links=${r2.info.links}`);
process.exit(fail ? 1 : 0);
