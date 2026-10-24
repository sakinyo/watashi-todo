// 画面の共通部品
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const $ = (sel, root = document) => root.querySelector(sel);
export { $ };

// ─── お知らせ（下部に一時表示） ───
let toastTimer = null;
export function toast(message, { action, onAction, error = false, ms = 4000 } = {}) {
  const root = $('#toast-root');
  clearTimeout(toastTimer);
  root.innerHTML = `<div class="toast ${error ? 'toast-error' : ''}" role="status">
    <span>${esc(message)}</span>${action ? `<button type="button" class="toast-btn">${esc(action)}</button>` : ''}</div>`;
  if (action) root.querySelector('.toast-btn').onclick = () => { root.innerHTML = ''; onAction?.(); };
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, error ? Math.max(ms, 8000) : ms);
}

// ─── 常時表示のエラー帯 ───
export function showErrorBar(message) {
  const bar = $('#error-bar');
  bar.innerHTML = `<div class="errorbar" role="alert"><span>⚠️ ${esc(message)}</span><button type="button" aria-label="閉じる">×</button></div>`;
  bar.querySelector('button').onclick = () => { bar.innerHTML = ''; };
}

// ─── 下から出るシート ───
let sheetStack = [];
export function openSheet(html, { onMount, full = false, onClose } = {}) {
  const root = $('#sheet-root');
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet ${full ? 'sheet-full' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(wrap);
  const entry = { wrap, onClose };
  sheetStack.push(entry);
  wrap.querySelector('.sheet-backdrop').onclick = () => closeSheet();
  document.body.classList.add('sheet-open');
  onMount?.(wrap.querySelector('.sheet'));
  return wrap.querySelector('.sheet');
}

export function closeSheet() {
  const entry = sheetStack.pop();
  if (!entry) return;
  entry.wrap.remove();
  if (!sheetStack.length) document.body.classList.remove('sheet-open');
  entry.onClose?.();
}

export function closeAllSheets() {
  while (sheetStack.length) closeSheet();
}

// ─── ファイルの保存（iPhoneでは共有シート →「"ファイル"に保存」） ───
export async function saveFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return 'cancelled';
    // 共有できない環境はダウンロードに切り替える
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

// ─── ファイルの選択 ───
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.onchange = async () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return resolve(null);
      try { resolve({ name: f.name, text: await f.text() }); } catch (e) { resolve({ name: f.name, error: e }); }
    };
    document.body.appendChild(input);
    input.click();
  });
}
