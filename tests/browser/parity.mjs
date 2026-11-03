// 파이썬(OpenCV)과 JS 이식본의 수치 일치 검증. 사용: node tests/browser/parity.mjs FIXTURE_DIR
import fs from 'node:fs';
import { prepare, changeScore, blendRatio } from '../../docs/core.js';

const dir = process.argv[2];
const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`));
const rd = (f) => new Uint8Array(fs.readFileSync(`${dir}/${f}`));
let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fail++; };

const smalls = [];
meta.frames.forEach((fm, i) => {
  const rgba = new Uint8ClampedArray(rd(`f${i}.rgba`));
  const p = prepare(rgba, meta.w, meta.h, 320);
  const ref = rd(`f${i}.small`);
  let maxd = 0, sum = 0;
  for (let k = 0; k < ref.length; k++) { const d = Math.abs(ref[k] - p.small[k]); maxd = Math.max(maxd, d); sum += d; }
  check(`frame${i} small size`, p.sh === fm.small_h && ref.length === p.small.length, `${p.sw}x${p.sh}`);
  check(`frame${i} small pixels (max|d|<=2)`, maxd <= 2, `max=${maxd} mean=${(sum / ref.length).toFixed(4)}`);
  smalls.push(ref); // 점수 비교는 파이썬이 만든 축소본을 입력으로 써서 지표 자체만 검증한다
});
for (const [i, j, expect] of meta.scores) {
  const got = changeScore(smalls[i], smalls[j], 320, meta.frames[0].small_h);
  check(`changeScore ${i}->${j}`, Math.abs(got - expect) < 1e-9, `py=${expect.toFixed(4)} js=${got.toFixed(4)}`);
}
const bl = rd('blend.small'), h = meta.frames[0].small_h;
const rb = blendRatio(smalls[0], bl, smalls[3]), ri = blendRatio(smalls[0], smalls[4], smalls[3]);
check('blendRatio blend', Math.abs(rb - meta.blend.real_blend) < 1e-6, `py=${meta.blend.real_blend.toFixed(4)} js=${rb.toFixed(4)}`);
check('blendRatio independent', Math.abs(ri - meta.blend.independent) < 1e-6, `py=${meta.blend.independent.toFixed(4)} js=${ri.toFixed(4)}`);
process.exit(fail ? 1 : 0);
