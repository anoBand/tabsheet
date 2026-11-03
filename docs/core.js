// core.js — tabsheet 알고리즘의 브라우저(JS) 이식. DOM에 의존하지 않아 Node에서도 같은 코드를 검증할 수 있다.
//
// 파이프라인은 tabsheet/core.py와 같다.
//   1) 일정 간격으로 악보 영역(bbox)을 잘라 받는다  -> Extractor.push(t, rgba, w, h)
//   2) 연속 샘플의 '변화 점수'로 한 악보가 정지한 구간(run)을 찾는다
//   3) run 안의 프레임을 픽셀별 중앙값으로 합쳐 재생 커서/하이라이트를 지운다
//   4) 직전 악보와 같으면 병합, 짧으면서 앞뒤 페이지의 혼합으로 설명되면 페이드 잔상으로 표시 -> Extractor.finish()

export const DEFAULTS = {
  interval: 0.5,     // 샘플링 간격(초)
  pixThr: 25,        // 밝기 차이가 이 값을 넘으면 '변했다'
  stableThr: 0.10,   // 직전 샘플과의 변화 점수가 이 이하면 같은 악보
  anchorThr: 0.20,   // 구간 첫 샘플과의 변화 점수 한계 (느린 페이드 방지)
  minRun: 2,         // 안정 구간으로 인정할 최소 연속 샘플 수
  dedupeThr: 0.05,   // 직전 악보와 이 이하면 같은 악보로 병합
  fadeRatio: 0.75,   // 앞뒤 페이지 혼합으로 설명되는 정도가 이 값보다 작으면 페이드 잔상 (0이면 끔)
  fadeMaxSec: 2.0,   // 이 시간보다 오래 정지한 구간은 페이드일 수 없으므로 판정하지 않음
  median: true,      // 구간 내 프레임 픽셀별 중앙값으로 커서 제거
  smallWidth: 320,   // 비교용 축소 폭
};

const MAX_KEEP = 16; // 구간당 중앙값 계산용으로 보관할 최대 프레임 수 (메모리 상한)

// ---------------------------------------------------------------- 이미지 유틸
/** RGBA -> 8비트 회색조 (OpenCV BGR2GRAY와 같은 정수 계수) */
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + 8192) >> 14;
  }
  return g;
}

/** 회색조 영역 평균 축소 (OpenCV INTER_AREA와 같은 분수 가중치 방식). */
export function resizeAreaGray(src, sw, sh, dw, dh) {
  const sx = sw / dw, sy = sh / dh;
  // 가로: sw -> dw (행마다)
  const tmp = new Float32Array(dw * sh);
  const wx = [];
  for (let x = 0; x < dw; x++) {
    const a = x * sx, b = (x + 1) * sx;
    const i0 = Math.floor(a), i1 = Math.min(Math.ceil(b), sw);
    const ws = [];
    for (let i = i0; i < i1; i++) ws.push(Math.min(b, i + 1) - Math.max(a, i));
    wx.push([i0, ws]);
  }
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < dw; x++) {
      const [i0, ws] = wx[x];
      let s = 0;
      for (let k = 0; k < ws.length; k++) s += src[row + i0 + k] * ws[k];
      tmp[y * dw + x] = s / sx;
    }
  }
  // 세로: sh -> dh
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const a = y * sy, b = (y + 1) * sy;
    const j0 = Math.floor(a), j1 = Math.min(Math.ceil(b), sh);
    for (let x = 0; x < dw; x++) {
      let s = 0;
      for (let j = j0; j < j1; j++) s += tmp[j * dw + x] * (Math.min(b, j + 1) - Math.max(a, j));
      out[y * dw + x] = Math.round(s / sy);
    }
  }
  return out;
}

/** 라플라시안 분산 (선명도). 가장자리 1픽셀은 제외. */
export function sharpness(g, w, h) {
  let sum = 0, sumsq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      const l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      sum += l; sumsq += l * l; n++;
    }
  }
  const mean = sum / n;
  return sumsq / n - mean * mean;
}

/** 크롭 한 장에서 비교용 축소 회색조와 선명도를 만든다. */
export function prepare(rgba, w, h, smallWidth) {
  const gray = toGray(rgba, w, h);
  const sw = smallWidth, sh = Math.max(1, Math.round(h * (smallWidth / w)));
  return { small: resizeAreaGray(gray, w, h, sw, sh), sw, sh, sharp: sharpness(gray, w, h) };
}

// ---------------------------------------------------------------- 판정 지표
/** 변화 점수: 변한 픽셀이 충분히 몰려 있는 세로 열의 비율. 0=동일, 1=완전히 다름.
 *  악보 교체/페이드는 크고, 얇은 재생 커서나 압축 잡음은 작다. */
export function changeScore(a, b, w, h, pixThr = 25) {
  const minRows = Math.max(2, Math.floor(0.05 * h));
  const cols = new Int32Array(w);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (Math.abs(a[i] - b[i]) > pixThr) cols[x]++;
    }
  }
  let n = 0;
  for (let x = 0; x < w; x++) if (cols[x] >= minRows) n++;
  return n / w;
}

/** cur가 앞뒤 페이지(prev, nxt)의 알파 혼합으로 얼마나 잘 설명되는지.
 *  0에 가까우면 크로스페이드 중간 프레임, 1 근처면 독립된 페이지. 악보 밀도와 무관하다.
 *  앞뒤가 사실상 같으면 판정 불가이므로 1.0. */
export function blendRatio(prev, cur, nxt) {
  const n = cur.length;
  let gap = 0;
  for (let i = 0; i < n; i++) gap += Math.abs(prev[i] - nxt[i]);
  if (gap / n < 2.0) return 1.0;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const d = prev[i] - nxt[i];
    num += (cur[i] - nxt[i]) * d;
    den += d * d;
  }
  const alpha = Math.min(1, Math.max(0, num / den));
  let eb = 0, ep = 0, en = 0;
  for (let i = 0; i < n; i++) {
    const blend = alpha * prev[i] + (1 - alpha) * nxt[i];
    eb += Math.abs(cur[i] - blend);
    ep += Math.abs(cur[i] - prev[i]);
    en += Math.abs(cur[i] - nxt[i]);
  }
  return (eb / n) / Math.max(Math.min(ep, en) / n, 1e-6);
}

// ---------------------------------------------------------------- 구간 추적
/** 한 악보가 정지해 있는 구간. 대표 이미지는 구간 내 프레임의 픽셀별 중앙값. */
class Run {
  constructor(t, rgba, prep) {
    this.tStart = this.tEnd = t;
    this.n = 0;
    this.anchor = prep.small;
    this.crops = [];
    this.stride = 1;
    this.best = rgba;
    this.bestSharp = -1;
    this.add(t, rgba, prep.sharp);
  }

  add(t, rgba, sharp) {
    this.tEnd = t;
    if (sharp > this.bestSharp) { this.best = rgba; this.bestSharp = sharp; } // 폴백: 가장 선명한 한 장
    if (this.n % this.stride === 0) {
      this.crops.push(rgba);
      if (this.crops.length > MAX_KEEP) {
        this.crops = this.crops.filter((_, i) => i % 2 === 0);
        this.stride *= 2;
      }
    }
    this.n++;
  }

  /** 움직이는 커서/하이라이트는 프레임마다 위치가 달라 중앙값에서 사라진다. */
  image(useMedian, w, h) {
    if (!useMedian || this.crops.length < 3) return this.best;
    const k = this.crops.length;
    const out = new Uint8ClampedArray(w * h * 4);
    const buf = new Uint8Array(k);
    const mid = k >> 1;
    for (let p = 0; p < out.length; p += 4) {
      for (let c = 0; c < 3; c++) {
        for (let m = 0; m < k; m++) {            // 삽입 정렬 (k <= 16)
          const v = this.crops[m][p + c];
          let q = m;
          while (q > 0 && buf[q - 1] > v) { buf[q] = buf[q - 1]; q--; }
          buf[q] = v;
        }
        // np.median과 같음: 짝수면 가운데 두 값의 평균 후 버림
        out[p + c] = k & 1 ? buf[mid] : (buf[mid - 1] + buf[mid]) >> 1;
      }
      out[p + 3] = 255;
    }
    return out;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

export class Extractor {
  /** @param {Partial<typeof DEFAULTS>} params */
  constructor(params = {}) {
    this.p = { ...DEFAULTS, ...params };
    this.candidates = [];
    this.run = null;
    this.prevSmall = null;
    this.size = null;
    this.debug = []; // [t, 직전 대비 점수, 구간 첫 샘플 대비 점수]
  }

  /** 샘플 한 장을 넣는다. rgba(Uint8ClampedArray)는 보관되므로 재사용하지 말 것. */
  push(t, rgba, w, h) {
    const p = this.p;
    this.size = { w, h };
    const prep = prepare(rgba, w, h, p.smallWidth);
    if (!this.run) {
      this.run = new Run(t, rgba, prep);
    } else {
      const sPrev = changeScore(this.prevSmall, prep.small, prep.sw, prep.sh, p.pixThr);
      const sAnchor = changeScore(this.run.anchor, prep.small, prep.sw, prep.sh, p.pixThr);
      this.debug.push([Math.round(t * 1000) / 1000, sPrev, sAnchor]);
      if (sPrev <= p.stableThr && sAnchor <= p.anchorThr) {
        this.run.add(t, rgba, prep.sharp);
      } else {
        this._close(this.run);
        this.run = new Run(t, rgba, prep);
      }
    }
    this.prevSmall = prep.small;
    this.sw = prep.sw; this.sh = prep.sh;
  }

  _close(r) {
    if (r && r.n >= this.p.minRun) this.candidates.push(r);
  }

  /** 마무리: 병합 + 페이드 잔상 판정. 중앙값 계산이 무거우니 구간마다 UI에 숨 돌릴 틈을 준다.
   *  @returns {Promise<{index:number,tStart:number,tEnd:number,image:{rgba:Uint8ClampedArray,w:number,h:number},faded:boolean}[]>} */
  async finish({ keepFaded = false, onProgress } = {}) {
    const p = this.p;
    this._close(this.run);
    this.run = null;
    if (!this.size) return [];
    const { w, h } = this.size;

    const merged = [];
    let done = 0;
    for (const r of this.candidates) {
      const rgba = r.image(p.median, w, h);
      const small = prepare(rgba, w, h, p.smallWidth).small;
      const last = merged[merged.length - 1];
      if (last && changeScore(last.small, small, this.sw, this.sh, p.pixThr) <= p.dedupeThr) {
        last.tEnd = r.tEnd;
      } else {
        merged.push({ tStart: r.tStart, tEnd: r.tEnd, rgba, small });
      }
      if (onProgress) onProgress(++done / this.candidates.length);
      await tick();
    }

    const out = [];
    merged.forEach((m, i) => {
      const short = m.tEnd - m.tStart + p.interval <= p.fadeMaxSec;
      let faded = false;
      if (p.fadeRatio > 0 && short && i > 0 && i < merged.length - 1) {
        faded = blendRatio(merged[i - 1].small, m.small, merged[i + 1].small) < p.fadeRatio;
      }
      if (faded && !keepFaded) return;
      out.push({ index: out.length + 1, tStart: m.tStart, tEnd: m.tEnd, image: { rgba: m.rgba, w, h }, faded });
    });
    return out;
  }
}
