// media.js — 내 컴퓨터의 폴더에서 영상 파일을 '업로드 없이' 고른다.
//  (File System Access API, 없으면 webkitdirectory 입력으로 대체)
const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i;
const MAX_DEPTH = 3;

async function walk(dirHandle, prefix = '', depth = 0, acc = []) {
  for await (const [name, h] of dirHandle.entries()) {
    if (h.kind === 'file' && VIDEO_RE.test(name)) acc.push({ label: prefix + name, getFile: () => h.getFile() });
    else if (h.kind === 'directory' && depth < MAX_DEPTH && !name.startsWith('.')) await walk(h, `${prefix}${name}/`, depth + 1, acc);
  }
  return acc;
}

/** @param {{box:HTMLElement, select:HTMLSelectElement, openBtn:HTMLElement, folderBtn:HTMLElement, dirInput:HTMLInputElement,
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
      ui.onFile(await it.getFile());
    } catch (e) { ui.status(`열지 못했습니다: ${e.message || e}`, true); }
  };
}
