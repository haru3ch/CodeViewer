// 線だけ（アウトライン）のアイコン。色は文字色に合わせる（currentColor）。
// 24×24 の枠に線で描いた単純な図形で、絵文字の代わりに使う。

const P = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  settings: '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-.01"/><circle cx="16" cy="6" r="2.4"/><circle cx="10" cy="12" r="2.4"/><circle cx="18" cy="18" r="2.4"/>',
  copy: '<rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="M16 4.5h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  resize: '<path d="M7 15l5 5 5-5M7 9l5-5 5 5"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bug: '<path d="M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM12 10v9M3 13h5M16 13h5M4.5 7L8 9.5M19.5 7L16 9.5M4.5 20L8 17M19.5 20L16 17"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  warn: '<path d="M12 3l10 18H2zM12 10v5M12 18h.01"/>',
};

/** アイコンの SVG（HTML 文字列） */
export function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

/** アイコンの要素 */
export function iconEl(name) {
  const t = document.createElement('template');
  t.innerHTML = icon(name);
  return t.content.firstChild;
}

/** HTML に書いた <i data-icon="名前"></i> をアイコンに置き換える */
export function applyIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) el.replaceWith(iconEl(el.dataset.icon));
}
