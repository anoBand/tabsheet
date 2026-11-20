// media.js — 서버의 videos/ 폴더 목록에서 영상을 '업로드 없이' 연다 (디버깅용).
// 개발용 주소에서만 동작한다: 로컬 정적 서버, Codespaces, dev.algernon.page (영상은 git 밖, dev 전용 폴더).
// 실제 사이트(tab.algernon.page 등)에서는 요청 자체를 하지 않는다.
const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
export const DEV_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|dev\.algernon\.page|.+\.app\.github\.dev)$/;

/** 디렉터리 목록 HTML에서 영상 링크만 뽑는다 (python -m http.server, nginx autoindex 등). */
export function parseListing(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('?') || href.startsWith('/') || href.includes('://') || href.endsWith('/')) continue;
    const name = decodeURIComponent(href);
    if (VIDEO_RE.test(name)) out.push({ label: name, href });
  }
  return out;
}

/** @param {{box:HTMLElement, select:HTMLSelectElement, openBtn:HTMLElement, serverBtn:HTMLElement,
 *           onFile:(f:File)=>void, status:(msg:string, err?:boolean)=>void}} ui */
export function initMedia(ui) {
  if (!DEV_HOST_RE.test(location.hostname)) return;
  let items = [];
  const fill = (list) => {
    items = list;
    ui.select.replaceChildren(...list.map((it, i) => Object.assign(document.createElement('option'), { value: i, textContent: it.label })));
    ui.box.hidden = false;
    ui.openBtn.disabled = !list.length;
    ui.status(list.length ? `서버의 videos/ 폴더에서 영상 ${list.length}개를 찾았습니다.` : '서버의 videos/ 폴더에 영상 파일이 없습니다.', !list.length);
  };

  /** 서버의 videos/ 목록을 읽는다. silent면 목록이 없거나 비어 있어도 아무 말 없이 넘어간다. */
  async function loadServer(silent) {
    // 사이트 루트에서는 둘 다 /videos/ 이므로 한 번만 요청 (로컬에서 /docs/ 로 열면 ../videos/ 가 프로젝트 루트)
    const bases = [...new Set(['videos/', '../videos/'].map((b) => new URL(b, location.href).href))];
    for (const base of bases) {
      try {
        const r = await fetch(base, { cache: 'no-store' });
        if (!r.ok || !(r.headers.get('content-type') || '').includes('html')) continue;
        const list = parseListing(await r.text()).map((v) => ({ label: v.label, url: new URL(v.href, base).href }));
        if (silent && !list.length) return;
        return fill(list);
      } catch { /* 다음 후보 */ }
    }
    if (!silent) ui.status('서버에서 videos/ 폴더 목록을 읽을 수 없습니다.', true);
  }
  ui.serverBtn.onclick = () => loadServer(false);
  loadServer(true);

  ui.openBtn.onclick = async () => {
    const it = items[+ui.select.value];
    if (!it) return;
    try {
      ui.status(`${it.label} 가져오는 중… (파일 전체를 이 브라우저로 불러옵니다)`);
      const r = await fetch(it.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ui.onFile(new File([await r.blob()], it.label, { type: r.headers.get('content-type') || 'video/mp4' }));
      ui.status('');
    } catch (e) { ui.status(`열지 못했습니다: ${e.message || e}`, true); }
  };
}
