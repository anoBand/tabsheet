// media.js — 영상 파일을 '업로드 없이' 고르는 두 가지 방법.
//  1) 이 서버의 videos/ 폴더 (정적 서버의 디렉터리 목록을 읽어 파일을 가져옴)
//  2) 내 컴퓨터의 폴더 (File System Access API, 없으면 webkitdirectory 입력으로 대체)
const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
const MAX_DEPTH = 3;

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

async function walk(dirHandle, prefix = '', depth = 0, acc = []) {
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === 'file' && VIDEO_RE.test(name)) acc.push({ label: prefix + name, getFile: () => h.getFile() });
    else if (h.kind === 'directory' && depth < MAX_DEPTH && !name.startsWith('.')) await walk(h, `${prefix}${name}/`, depth + 1, acc);
  }
  return acc;
}

/** @param {{box:HTMLElement, select:HTMLSelectElement, openBtn:HTMLElement, serverBtn:HTMLElement, folderBtn:HTMLElement, dirInput:HTMLInputElement,
 *           onFile:(f:File)=>void, status:(msg:string, err?:boolean)=>void}} ui */
export function initMedia(ui) {
  let items = [];
  const fill = (list, note) => {
    items = list;
    ui.select.replaceChildren(...list.map((it, i) => Object.assign(document.createElement('option'), { value: i, textContent: it.label })));
    ui.box.hidden = false;
    ui.openBtn.disabled = !list.length;
    ui.status(list.length ? `${note} 영상 ${list.length}개를 찾았습니다.` : `${note} 영상 파일을 찾지 못했습니다.`, !list.length);
  };

  ui.serverBtn.onclick = async () => {
    for (const base of ['videos/', '../videos/']) {
      try {
        const r = await fetch(base, { cache: 'no-store' });
        if (!r.ok || !(r.headers.get('content-type') || '').includes('html')) continue;
        const list = parseListing(await r.text()).map((v) => ({ label: v.label, base, href: v.href }));
        return fill(list, '서버의 videos/ 폴더에서');
      } catch { /* 다음 후보 */ }
    }
    ui.status('이 서버에서 videos/ 폴더 목록을 읽을 수 없습니다. 정적 서버를 프로젝트 루트에서 실행했는지 확인하세요.', true);
  };

  ui.folderBtn.onclick = async () => {
    if (!window.showDirectoryPicker) return ui.dirInput.click(); // Firefox/Safari
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read' });
      fill(await walk(dir), `'${dir.name}' 폴더에서`);
    } catch (e) { if (e.name !== 'AbortError') ui.status(String(e.message || e), true); }
  };
  ui.dirInput.onchange = () => {
    const files = [...ui.dirInput.files].filter((f) => VIDEO_RE.test(f.name));
    fill(files.map((f) => ({ label: f.webkitRelativePath || f.name, getFile: async () => f })), '선택한 폴더에서');
  };

  ui.openBtn.onclick = async () => {
    const it = items[+ui.select.value];
    if (!it) return;
    try {
      if (it.getFile) return ui.onFile(await it.getFile());
      ui.status(`${it.label} 가져오는 중… (파일 전체를 이 브라우저로 불러옵니다)`);
      const r = await fetch(it.base + it.href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ui.onFile(new File([await r.blob()], it.label, { type: r.headers.get('content-type') || 'video/mp4' }));
      ui.status('');
    } catch (e) { ui.status(`열지 못했습니다: ${e.message || e}`, true); }
  };
}
