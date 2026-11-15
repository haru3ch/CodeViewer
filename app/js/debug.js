// デバッグ表示。PC がなくてもスマホ単体でエラーやログを見られるようにする。
// ログ自体は index.html の先頭のスクリプトが常に集めている（window.__crLog）。
// ここでは、デバッグがオンのときに 🐞 ボタンとログ画面を出すだけ。

import * as db from './db.js';

export const APP_VERSION = '2026-11-15k';

let btn = null;
let panel = null;
let body = null;

const time = (t) => new Date(t).toLocaleTimeString('ja-JP', { hour12: false });

function logText() {
  return (window.__crLog || []).map((x) => `${time(x.time)} [${x.level}] ${x.msg}`).join('\n');
}

async function envInfo() {
  const lines = [];
  const add = (k, v) => lines.push(`${k}: ${v}`);
  add('アプリの版', APP_VERSION);
  add('アドレス', location.href);
  add('ブラウザ', navigator.userAgent);
  add('ホーム画面から起動', window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true ? 'はい' : 'いいえ');
  add('画面', `${window.innerWidth}×${window.innerHeight}（倍率 ${window.devicePixelRatio}）`);
  add('安全な接続（https / localhost）', window.isSecureContext ? 'はい' : 'いいえ（コピーやオフライン機能の一部が使えません）');
  add('フォルダ選択（webkitdirectory）', 'webkitdirectory' in document.createElement('input') ? '対応' : '非対応');
  add('フォルダ選択（showDirectoryPicker）', 'showDirectoryPicker' in window ? '対応' : '非対応');
  add('クリップボードAPI', navigator.clipboard && window.isSecureContext ? '使える' : '使えない（別の方法でコピー）');
  add('Service Worker', 'serviceWorker' in navigator
    ? (navigator.serviceWorker.controller ? '動作中' : '未登録または未適用')
    : '非対応');
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      add('保存領域', `${(e.usage / 1048576).toFixed(1)} MB 使用 / 上限 ${(e.quota / 1048576).toFixed(0)} MB`);
    }
    if (navigator.storage && navigator.storage.persisted) add('保存の永続化', (await navigator.storage.persisted()) ? 'はい' : 'いいえ（容量不足時に消える可能性あり）');
  } catch (err) { add('保存領域', `取得失敗 ${err.message}`); }
  try {
    const repos = await db.listRepos();
    add('読み込んだフォルダ', repos.length ? repos.map((r) => `${r.name}（${r.files.filter((f) => !f.skip).length}件）`).join(', ') : 'なし');
  } catch (err) { add('読み込んだフォルダ', `取得失敗 ${err.message}`); }
  return lines.join('\n');
}

function render() {
  if (!body) return;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.replaceChildren();
  for (const x of window.__crLog || []) {
    const line = document.createElement('div');
    line.className = `lv-${x.level}`;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${time(x.time)} `;
    line.append(t, document.createTextNode(`[${x.level}] ${x.msg}`));
    body.append(line);
  }
  if (atBottom) body.scrollTop = body.scrollHeight;
}

function updateBadge() {
  if (!btn) return;
  btn.classList.toggle('has-error', (window.__crLog || []).some((x) => x.level === 'error'));
}

async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 下へ */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function buildPanel() {
  panel = document.createElement('div');
  panel.className = 'dbg-panel hidden';
  const head = document.createElement('div');
  head.className = 'dbg-head';
  const title = document.createElement('strong');
  title.textContent = '🐞 デバッグ';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  body = document.createElement('div');
  body.className = 'dbg-body';
  head.append(
    title,
    mk('環境情報', async () => { console.info(`環境情報\n${await envInfo()}`); }),
    mk('コピー', async () => {
      const ok = await copy(`${await envInfo()}\n\n--- ログ ---\n${logText()}`);
      console.info(ok ? '環境情報とログをコピーしました' : 'コピーできませんでした（長押しで選択してください）');
    }),
    mk('クリア', () => { window.__crLog.length = 0; render(); updateBadge(); }),
    mk('再読み込み', () => location.reload()),
    mk('✕', () => panel.classList.add('hidden')),
  );
  panel.append(head, body);
  document.body.append(panel);
}

export function setDebugEnabled(on) {
  try {
    if (on) localStorage.setItem('cr-debug', '1');
    else localStorage.removeItem('cr-debug');
  } catch { /* 保存できない環境 */ }
  window.__crDebug = on;
  if (on) showDebugUi();
  else { btn?.remove(); panel?.remove(); btn = panel = body = null; }
}

export function isDebugEnabled() { return !!window.__crDebug; }

export function showDebugUi() {
  if (btn) return;
  btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dbg-btn';
  btn.textContent = '🐞';
  btn.setAttribute('aria-label', 'デバッグ表示');
  btn.addEventListener('click', () => {
    if (!panel) buildPanel();
    panel.classList.toggle('hidden');
    render();
    body.scrollTop = body.scrollHeight;
  });
  document.body.append(btn);
  updateBadge();
  window.__crLogUpdate = () => {
    updateBadge();
    if (panel && !panel.classList.contains('hidden')) render();
  };
  console.info(`デバッグ表示オン（版 ${APP_VERSION}）`);
}

export function initDebug() {
  if (window.__crDebug) showDebugUi();
}

export { copy as copyText };
