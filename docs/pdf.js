// pdf.js — 악보 조각을 A4 페이지에 쌓고(JPG) 외부 라이브러리 없이 PDF로 묶는다.
// layout()/buildPdf()는 DOM이 필요 없어 Node에서도 테스트할 수 있고, composePages()만 canvas를 쓴다.

export const PAGE = { w: 1654, h: 2339, margin: 80, gap: 40, maxUpscale: 3.0, quality: 0.92 }; // A4 @ 200dpi (core.py와 동일)

/** 조각 크기 목록 [{w,h}] -> 페이지별 배치 [[{i,x,y,w,h}]]. tabsheet.core.build_sheet와 같은 규칙. */
export function layout(sizes, o = PAGE) {
  const cw = o.w - 2 * o.margin, ch = o.h - 2 * o.margin;
  const pages = [[]];
  let y = o.margin;
  sizes.forEach((s, i) => {
    let scale = Math.min(cw / s.w, o.maxUpscale);
    if (s.h * scale > ch) scale = ch / s.h;
    const w = Math.max(1, Math.round(s.w * scale)), h = Math.max(1, Math.round(s.h * scale));
    if (pages[pages.length - 1].length && y + h > o.h - o.margin) { pages.push([]); y = o.margin; }
    pages[pages.length - 1].push({ i, x: Math.floor((o.w - w) / 2), y, w, h });
    y += h + o.gap;
  });
  return pages;
}

/** 브라우저 전용: 조각(캔버스/ImageBitmap) -> 페이지 JPEG. */
export async function composePages(sources, o = PAGE) {
  const pages = layout(sources.map((s) => ({ w: s.width, h: s.height })), o);
  const out = [];
  for (const items of pages) {
    const c = new OffscreenCanvas(o.w, o.h);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, o.w, o.h);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    for (const it of items) g.drawImage(sources[it.i], it.x, it.y, it.w, it.h);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: o.quality });
    out.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: o.w, h: o.h });
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/** JPEG 페이지들을 PDF 한 파일로. 페이지 크기는 200dpi 기준 pt (px * 72/200). */
export function buildPdf(pages, dpi = 200) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const put = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; chunks.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; put(`${n} 0 obj\n`); put(body); put('\nendobj\n'); };

  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // 객체 번호: 1=Catalog, 2=Pages, 페이지 i: 3+3i(Page) 4+3i(Content) 5+3i(Image)
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>`);
  pages.forEach((p, i) => {
    const wpt = (p.w * 72 / dpi).toFixed(2), hpt = (p.h * 72 / dpi).toFixed(2);
    const base = 3 + 3 * i;
    obj(base, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt} ${hpt}] /Resources << /XObject << /Im0 ${base + 2} 0 R >> >> /Contents ${base + 1} 0 R >>`);
    const content = `q ${wpt} 0 0 ${hpt} 0 0 cm /Im0 Do Q`;
    obj(base + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    offsets[base + 2] = len;
    put(`${base + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    put(p.jpeg);
    put('\nendstream\nendobj\n');
  });
  const total = 3 + 3 * n;
  const xref = len;
  put(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let k = 1; k < total; k++) put(`${String(offsets[k]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
