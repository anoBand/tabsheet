// 순수 JS 단위 테스트 (브라우저 불필요): node tests/browser/unit.mjs
import { changeScore, blendRatio, Extractor } from '../../docs/core.js';

let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fail++; };
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const W = 320, H = 60;
const page = () => Uint8Array.from({ length: W * H }, () => (rnd() > 0.9 ? 230 : 30));

// 변화 점수: 같은 화면 0, 얇은 커서(3열)는 작고, 다른 페이지는 크다
const A = page(), B = page();
check('changeScore 동일=0', changeScore(A, A.slice(), W, H) === 0);
const cur = A.slice(); for (let y = 0; y < H; y++) for (let x = 100; x < 103; x++) cur[y * W + x] = 255 - cur[y * W + x];
check('changeScore 얇은 커서는 작음', changeScore(A, cur, W, H) < 0.03, changeScore(A, cur, W, H).toFixed(3));
check('changeScore 다른 페이지는 큼', changeScore(A, B, W, H) > 0.5, changeScore(A, B, W, H).toFixed(3));

// 페이드 판정: 앞뒤 혼합은 낮고, 독립 페이지는 높고, 앞뒤가 같으면 판정 불가(1.0)
const C = page();
const mix = Uint8Array.from(A, (v, i) => Math.round(0.4 * v + 0.6 * B[i]));
check('blendRatio 혼합 < 0.2', blendRatio(A, mix, B) < 0.2, blendRatio(A, mix, B).toFixed(3));
check('blendRatio 독립 > 0.8', blendRatio(A, C, B) > 0.8, blendRatio(A, C, B).toFixed(3));
check('blendRatio 앞뒤 동일 = 1', blendRatio(A, A.slice(), A.slice()) === 1);

// 추출기: 페이지 3장(컷) + 가운데 1장의 크로스페이드 프레임 -> 3조각 + 페이드 1개
const rgba = (g) => { const o = new Uint8ClampedArray(g.length * 4); g.forEach((v, i) => { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v; o[i * 4 + 3] = 255; }); return o; };
const P = [page(), page(), page()];
const mixAB = Uint8Array.from(P[0], (v, i) => Math.round(0.5 * v + 0.5 * P[1][i]));
const frames = [...Array(6).fill(P[0]), mixAB, ...Array(6).fill(P[1]), ...Array(20).fill(P[2])]; // 마지막은 길게 정지(성긴 페이지 시나리오)
const ex = new Extractor({});
frames.forEach((g, i) => ex.push(i * 0.5, rgba(g), W, H));
const segs = await ex.finish({ keepFaded: true });
check('추출기: 조각 3개', segs.filter((s) => !s.faded).length === 3, JSON.stringify(segs.map((s) => [s.tStart, s.tEnd, s.faded])));
check('추출기: 크로스페이드 1프레임은 잔상으로 제외되거나 합쳐짐', segs.filter((s) => s.faded).length <= 1);
const none = await new Extractor({}).finish();
check('추출기: 빈 입력', none.length === 0);
process.exit(fail ? 1 : 0);
