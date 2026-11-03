// PDF 작성기 + 배치 규칙 검증. 사용: node tests/browser/pdf.test.mjs OUT.pdf JPG1 JPG2 ...
import fs from 'node:fs';
import { buildPdf, layout, PAGE } from '../../docs/pdf.js';
const [out, ...jpgs] = process.argv.slice(2);
const pages = jpgs.map((f) => ({ jpeg: new Uint8Array(fs.readFileSync(f)), w: 300, h: 400 }));
fs.writeFileSync(out, buildPdf(pages, 200 * 300 / 1654)); // 샘플 JPEG 크기에 맞춰 페이지 크기가 A4가 되도록
// 배치: 가로 1494px 이상으로 확대 불가(최대 3배), 넘치면 다음 페이지
const L = layout(Array.from({ length: 12 }, () => ({ w: 1000, h: 200 })));
const inside = L.every((pg) => pg.every((it) => it.y >= PAGE.margin && it.y + it.h <= PAGE.h - PAGE.margin && it.x >= PAGE.margin));
console.log('pages', L.length, 'per page', L.map((p) => p.length).join(','), inside ? 'OK' : 'FAIL');
process.exit(inside && L.length === 2 ? 0 : 1);
