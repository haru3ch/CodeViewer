// コード読解リーダー：画面全体のつなぎ込み。
// 画面・機能の切り替えはボタンのタップだけで行い、スワイプには何も割り当てない。

import * as db from './db.js';
import * as files from './files.js';
import * as ai from './ai.js';
import { Viewer } from './viewer.js';
import { Chat } from './chat.js';
import { marked, DOMPurify } from '../vendor/vendor.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 設定
const SETTINGS_KEY = 'cr-settings';
const APIKEY_KEY = 'cr-apikey';
const LAST_REPO_KEY = 'cr-last-repo';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境 */ } }

const settings = Object.assign(
  { fontSize: 14, theme: 'auto', lineNumbers: true, model: ai.DEFAULT_MODEL, effort: 'medium', chatSize: 'normal' },
  JSON.parse(lsGet(SETTINGS_KEY) || '{}'),
);
if (!ai.MODELS.some((m) => m.id === settings.model)) settings.model = ai.DEFAULT_MODEL;
function saveSettings() { lsSet(SETTINGS_KEY, JSON.stringify(settings)); }
function apiKey() { return lsGet(APIKEY_KEY) || ''; }

// ---------------------------------------------------------------- 状態
const state = {
  repo: null,        // 開いているリポジトリ（db の repos のレコード）
  path: null,        // 開いているファイル
  text: '',
  mdMode: false,     // Markdown を整形表示中か
};

const viewer = new Viewer($('codeScroll'), $('codeLines'));

// ---------------------------------------------------------------- 表示設定の反映
function applySettings() {
  const fs = settings.fontSize;
  const lh = Math.round(fs * 1.6);
  document.documentElement.style.setProperty('--fs', `${fs}px`);
  document.documentElement.style.setProperty('--lh', `${lh}px`);
  const top = state.path ? viewer.topLine() : 0;
  viewer.setLineHeight(lh);
  if (state.path && top) viewer.scrollToLine(top);
  if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
  $('codeLines').classList.toggle('no-gutter', !settings.lineNumbers);
  $('fsVal').textContent = fs;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim() || '#1e2229';
  $('app').classList.toggle('chat-large', settings.chatSize === 'large');
}

// ---------------------------------------------------------------- 横スワイプで「戻る」させない
// 履歴を1つ積んでおき、戻る操作（端からのスワイプ・Androidの戻るジェスチャー）が来たら積み直すだけ。
// 画面は何も変えない。
function guardSwipeNavigation() {
  try {
    history.replaceState({ cr: 'base' }, '');
    history.pushState({ cr: 'guard' }, '');
    window.addEventListener('popstate', () => {
      history.pushState({ cr: 'guard' }, '');
    });
  } catch { /* 無視 */ }
}

// ---------------------------------------------------------------- 通知・進捗
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function progress(text, ratio) {
  const el = $('progress');
  if (text === null) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  $('progressText').textContent = text;
  $('progressBar').style.width = `${Math.round((ratio || 0) * 100)}%`;
}

// ---------------------------------------------------------------- パネル（開閉はボタンだけ）
function openPanel(id) {
  closePanels();
  $(id).classList.remove('hidden');
  $('backdrop').classList.remove('hidden');
}
function closePanels() {
  for (const id of ['treePanel', 'bmPanel']) $(id).classList.add('hidden');
  $('backdrop').classList.add('hidden');
}

// ---------------------------------------------------------------- 取り込み
function newRepoId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function importEntries(rootName, entries) {
  if (!entries.length) { toast('ファイルが選ばれませんでした'); return; }
  progress('読み込み中…', 0);
  try {
    const { meta, texts } = await files.readEntries(entries, (done, total, path) => {
      progress(`読み込み中… ${done} / ${total}\n${path}`, done / total);
    });
    if (!texts.length) { toast('読めるテキストファイルがありませんでした'); return; }
    const name = rootName || `読み込み ${new Date().toLocaleString('ja-JP')}`;
    // 同じ名前のフォルダを読み込み直したら、古い方を置き換える（しおりは引き継ぐ）
    const old = (await db.listRepos()).find((r) => r.name === name);
    const repo = { id: old ? old.id : newRepoId(), name, importedAt: Date.now(), files: meta };
    if (old) { await db.deleteRepoFiles(old.id); summaryCache.clear(); }
    progress('保存中…', 1);
    await db.saveRepo(repo, texts);
    await db.requestPersist();
    toast(`${texts.length} ファイルを読み込みました`);
    await openRepo(repo.id, { preferReading: true });
  } catch (err) {
    console.error(err);
    toast(`読み込みに失敗しました: ${err.message || err}`, 5000);
  } finally {
    progress(null);
  }
}

async function pickFolder() {
  closePanels();
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      progress('ファイルを探しています…', 0);
      const { rootName, entries } = await files.entriesFromDirHandle(handle);
      await importEntries(rootName, entries);
      return;
    } catch (err) {
      progress(null);
      if (err && err.name === 'AbortError') return;
      // 使えなければ下の方法へ
    }
  }
  if (files.supportsDirInput()) {
    $('dirInput').value = '';
    $('dirInput').click();
  } else {
    toast('このブラウザはフォルダ選択に対応していません。「ファイルを複数選んで読み込む」を使ってください。', 5000);
  }
}

function pickFiles() {
  closePanels();
  $('filesInput').value = '';
  $('filesInput').click();
}

$('dirInput').addEventListener('change', async (e) => {
  const { rootName, entries } = files.entriesFromFileList(e.target.files);
  await importEntries(rootName, entries);
});
$('filesInput').addEventListener('change', async (e) => {
  const { entries } = files.entriesFromFileList(e.target.files);
  await importEntries('', entries);
});

// ---------------------------------------------------------------- リポジトリ・ファイルツリー
function readingPath(repo) {
  const paths = repo.files.filter((f) => !f.skip).map((f) => f.path);
  const lower = (p) => p.toLowerCase();
  return paths.find((p) => lower(p) === 'reading.md')
    || paths.filter((p) => lower(p).endsWith('/reading.md')).sort((a, b) => a.length - b.length)[0]
    || null;
}
function readmePath(repo) {
  const paths = repo.files.filter((f) => !f.skip).map((f) => f.path);
  return paths.find((p) => /^readme(\.md|\.txt|\.rst)?$/i.test(p)) || null;
}

async function refreshRepoSelect() {
  const repos = await db.listRepos();
  const sel = $('repoSelect');
  sel.innerHTML = '';
  for (const r of repos) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = `📁 ${r.name}`;
    sel.append(o);
  }
  if (state.repo) sel.value = state.repo.id;
  $('btnDeleteRepo').disabled = !state.repo;

  // ようこそ画面の「前に読み込んだフォルダ」
  const box = $('welcomeRepos');
  box.innerHTML = '';
  if (repos.length) {
    const h = document.createElement('p');
    h.textContent = '前に読み込んだフォルダ';
    h.className = 'note';
    box.append(h);
    for (const r of repos) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `📁 ${r.name}（${r.files.filter((f) => !f.skip).length} ファイル）`;
      b.addEventListener('click', () => openRepo(r.id));
      box.append(b);
    }
  }
}

$('repoSelect').addEventListener('change', (e) => openRepo(e.target.value));

async function openRepo(id, { preferReading = false } = {}) {
  const repo = await db.getRepo(id);
  if (!repo) return;
  state.repo = repo;
  await warmSummary(repo);
  lsSet(LAST_REPO_KEY, id);
  await refreshRepoSelect();
  renderTree();
  const last = await db.kvGet(`last:${id}`);
  const reading = readingPath(repo);
  const exists = (p) => p && repo.files.some((f) => f.path === p && !f.skip);
  const target = (!preferReading && exists(last)) ? last
    : reading || (exists(last) ? last : readmePath(repo));
  if (target) await openFile(target);
  else { showWelcome(false); openPanel('treePanel'); }
}

function buildTree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const f of paths) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push({ ...f, name: parts[parts.length - 1] });
  }
  return root;
}

const SKIP_LABEL = { binary: 'バイナリ', large: '大きすぎ', error: '読めない' };

function fileButton(f, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'file';
  b.dataset.path = f.path;
  b.textContent = label;
  if (f.skip) {
    b.classList.add('skipped');
    const w = document.createElement('span');
    w.className = 'why';
    w.textContent = `（${SKIP_LABEL[f.skip] || f.skip}）`;
    b.append(w);
    b.disabled = true;
  }
  if (f.path === state.path) b.classList.add('current');
  return b;
}

function renderTree() {
  const el = $('tree');
  el.innerHTML = '';
  if (!state.repo) return;
  const filter = $('treeFilter').value.trim().toLowerCase();
  // .git は取り込み時点で除外済み。バイナリ等も一覧には出さない（仕様 §3.2）
  const list = state.repo.files.filter((f) => !f.skip || f.skip === 'large');

  const reading = readingPath(state.repo);
  if (reading && !filter) {
    const b = fileButton({ path: reading }, `📘 ${reading}`);
    b.classList.add('reading');
    el.append(b);
  }

  if (filter) {
    for (const f of list.filter((f) => f.path.toLowerCase().includes(filter))) {
      const b = fileButton(f, f.path.split('/').pop());
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (dir) { const s = document.createElement('span'); s.className = 'flat-path'; s.textContent = `  ${dir}`; b.append(s); }
      el.append(b);
    }
    return;
  }

  const openDirs = new Set();
  if (state.path) {
    const parts = state.path.split('/');
    for (let i = 1; i < parts.length; i++) openDirs.add(parts.slice(0, i).join('/'));
  }
  const renderNode = (node, prefix, container) => {
    const dirs = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    for (const d of dirs) {
      const full = prefix ? `${prefix}/${d}` : d;
      const det = document.createElement('details');
      if (openDirs.has(full)) det.open = true;
      const sum = document.createElement('summary');
      sum.textContent = d;
      det.append(sum);
      const kids = document.createElement('div');
      kids.className = 'children';
      det.append(kids);
      // 中身は開いたときに作る（大きなリポジトリでも軽く）
      let built = false;
      const build = () => { if (!built) { built = true; renderNode(node.dirs.get(d), full, kids); } };
      if (det.open) build();
      det.addEventListener('toggle', build);
      container.append(det);
    }
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) container.append(fileButton(f, f.name));
  };
  renderNode(buildTree(list), '', el);
}

$('tree').addEventListener('click', (e) => {
  const b = e.target.closest('.file');
  if (!b || b.disabled) return;
  closePanels();
  openFile(b.dataset.path);
});
$('treeFilter').addEventListener('input', () => renderTree());

$('btnDeleteRepo').addEventListener('click', async () => {
  if (!state.repo) return;
  if (!confirm(`「${state.repo.name}」をこの端末から削除しますか？\n（読書位置・しおり・会話も消えます。元のフォルダは消えません）`)) return;
  await db.deleteRepo(state.repo.id);
  state.repo = null; state.path = null;
  lsSet(LAST_REPO_KEY, '');
  closePanels();
  await refreshRepoSelect();
  const repos = await db.listRepos();
  if (repos.length) await openRepo(repos[0].id);
  else showWelcome(true);
});

// ---------------------------------------------------------------- ファイルを開く
function showWelcome(on) {
  $('welcome').classList.toggle('hidden', !on);
  if (on) {
    $('codeScroll').classList.add('hidden');
    $('mdView').classList.add('hidden');
    $('btnMdMode').classList.add('hidden');
    $('titleRepo').textContent = '';
    $('titlePath').textContent = 'コード読解リーダー';
    updateSelBar(null);
  }
}

async function openFile(path) {
  if (!state.repo) return;
  await savePosition();
  const text = await db.getFileText(state.repo.id, path);
  if (text === null) { toast('ファイルの本文がありません（大きすぎるファイルは保存していません）'); return; }
  state.path = path;
  state.text = text;
  showWelcome(false);
  $('titleRepo').textContent = state.repo.name;
  $('titlePath').textContent = `‎${path}`;
  $('codeScroll').classList.remove('hidden');
  viewer.render(text, files.langOf(path));
  await refreshBookmarkMarks();

  const isMd = files.isMarkdown(path);
  $('btnMdMode').classList.toggle('hidden', !isMd);
  // READING.md は最初から整形表示。それ以外の .md はソース表示。切り替えたらファイルごとに覚える
  const savedMd = await db.kvGet(`mdmode:${state.repo.id}:${path}`);
  setMdMode(isMd && (savedMd !== undefined ? savedMd : /(^|\/)reading\.md$/i.test(path)));

  const pos = await db.kvGet(`pos:${state.repo.id}:${path}`);
  viewer.scrollToLine(pos ? pos.line : 1, { left: pos ? pos.left : 0 });
  await db.kvSet(`last:${state.repo.id}`, path);
  for (const b of $('tree').querySelectorAll('.file')) b.classList.toggle('current', b.dataset.path === path);
  updateSelBar(null);
  await chat.loadFor(state.repo.id, path);
}

function setMdMode(on) {
  state.mdMode = on;
  $('btnMdMode').textContent = on ? 'ソース表示' : '整形表示';
  $('codeScroll').classList.toggle('hidden', on);
  $('mdView').classList.toggle('hidden', !on);
  if (on) {
    $('mdView').innerHTML = DOMPurify.sanitize(marked.parse(state.text));
    $('mdView').scrollTop = 0;
    updateSelBar(null);
  }
}
$('btnMdMode').addEventListener('click', async () => {
  setMdMode(!state.mdMode);
  if (state.repo && state.path) await db.kvSet(`mdmode:${state.repo.id}:${state.path}`, state.mdMode);
});

// ---------------------------------------------------------------- 読書位置
async function savePosition() {
  if (!state.repo || !state.path || state.mdMode) return;
  await db.kvSet(`pos:${state.repo.id}:${state.path}`, { line: viewer.topLine(), left: viewer.scrollEl.scrollLeft, at: Date.now() });
}
viewer.onScrollIdle = () => { savePosition(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePosition(); });
window.addEventListener('pagehide', () => { savePosition(); });

// ---------------------------------------------------------------- 行選択
function rangeLabel(r) { return r.a === r.b ? `L${r.a}` : `L${r.a}-L${r.b}`; }

function updateSelBar(sel) {
  const bar = $('selBar');
  if (!sel) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const n = sel.b - sel.a + 1;
  $('selInfo').textContent = sel.done
    ? `${rangeLabel(sel)}（${n}行）を選択中`
    : `開始 L${sel.a} → 終了行をタップ`;
}
viewer.onSelectionChange = updateSelBar;

$('btnClearSel').addEventListener('click', () => viewer.clearSelection());
$('btnExplain').addEventListener('click', () => {
  const r = viewer.range();
  if (!r) return;
  openChat();
  chat.explain(r);
});

// ---------------------------------------------------------------- しおり
let bmEditing = null;
async function refreshBookmarkMarks() {
  if (!state.repo || !state.path) return;
  const list = await db.listBookmarks(state.repo.id);
  viewer.setBookmarks(list.filter((b) => b.path === state.path).map((b) => b.line));
}

$('btnAddBookmark').addEventListener('click', () => {
  const r = viewer.range();
  if (!r || !state.repo) return;
  bmEditing = { repoId: state.repo.id, path: state.path, line: r.a, lineEnd: r.b, note: '', createdAt: Date.now() };
  $('bmDlgTitle').textContent = `しおりを追加（${rangeLabel(r)}）`;
  $('bmNote').value = '';
  $('bmDlg').showModal();
});
$('bmDlg').addEventListener('close', async () => {
  if ($('bmDlg').returnValue !== 'ok' || !bmEditing) { bmEditing = null; return; }
  bmEditing.note = $('bmNote').value.trim();
  if (bmEditing.id) await db.updateBookmark(bmEditing);
  else await db.addBookmark(bmEditing);
  bmEditing = null;
  await refreshBookmarkMarks();
  await renderBookmarks();
  toast('しおりを保存しました');
});

async function renderBookmarks() {
  const el = $('bmList');
  el.innerHTML = '';
  if (!state.repo) { el.innerHTML = '<p class="bm-empty">フォルダを読み込むと使えます。</p>'; return; }
  const list = await db.listBookmarks(state.repo.id);
  if (!list.length) {
    el.innerHTML = '<p class="bm-empty">しおりはまだありません。<br>行をタップして選び、下に出る「🔖 しおり」を押すと、メモ付きで保存できます。</p>';
    return;
  }
  for (const b of list) {
    const item = document.createElement('div');
    item.className = 'bm-item';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'bm-go';
    const where = document.createElement('span');
    where.className = 'bm-where';
    where.textContent = `${b.path}  ${rangeLabel({ a: b.line, b: b.lineEnd || b.line })}`;
    const note = document.createElement('span');
    note.className = 'bm-note';
    note.textContent = b.note || '（メモなし）';
    go.append(where, note);
    go.addEventListener('click', async () => {
      closePanels();
      if (state.path !== b.path) await openFile(b.path);
      if (state.mdMode) setMdMode(false);
      viewer.jumpTo(b.line, b.lineEnd || b.line);
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'bm-del';
    edit.style.color = 'inherit';
    edit.textContent = '✎';
    edit.setAttribute('aria-label', 'メモを編集');
    edit.addEventListener('click', () => {
      bmEditing = { ...b };
      $('bmDlgTitle').textContent = 'メモを編集';
      $('bmNote').value = b.note || '';
      $('bmDlg').showModal();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'bm-del';
    del.textContent = '🗑';
    del.setAttribute('aria-label', '削除');
    del.addEventListener('click', async () => {
      if (!confirm('このしおりを削除しますか？')) return;
      await db.deleteBookmark(b.id);
      await renderBookmarks();
      await refreshBookmarkMarks();
    });
    item.append(go, edit, del);
    el.append(item);
  }
}

// ---------------------------------------------------------------- チャット
const chat = new Chat({
  logEl: $('chatLog'),
  formEl: $('chatForm'),
  inputEl: $('chatInput'),
  sendBtn: $('btnSend'),
  stopBtn: $('btnStop'),
  contextEl: $('chatContext'),
  getSettings: () => ({ apiKey: apiKey(), model: settings.model, effort: settings.effort }),
  getFileContext: () => {
    if (!state.repo || !state.path) return null;
    const repo = state.repo;
    const path = state.path;
    return {
      repoId: repo.id,
      repoName: repo.name,
      path,
      range: () => (state.mdMode ? null : viewer.range()),
      numbered: (a, b) => viewer.numbered(a, b),
      lineText: (n) => viewer.lines[n - 1] || '',
      buildContext: () => buildContextFor(repo, path),
    };
  },
  onLineRef: async (path, a, b) => {
    if (state.path !== path) await openFile(path);
    if (state.mdMode) setMdMode(false);
    viewer.jumpTo(a, b);
  },
  needApiKey: () => {
    toast('AIを使うには ⚙ 設定で APIキー を入れてください', 4000);
    openSettings();
    setTimeout(() => $('setApiKey').focus(), 100);
  },
  toast,
});

function buildContextFor(repo, path) {
  const summaryPath = readingPath(repo) || readmePath(repo);
  // 要約はファイルを開いた時点で読めているとは限らないので、同期で使えるようキャッシュから取る
  const summaryText = summaryCache.get(`${repo.id}:${summaryPath}`) || '';
  return ai.buildContext({
    repoName: repo.name,
    filePaths: repo.files.filter((f) => !f.skip).map((f) => f.path),
    summaryName: summaryPath,
    summaryText: summaryPath === path ? '（対象ファイルそのもの）' : summaryText,
    path,
    numberedText: viewer.numbered(),
    lineCount: viewer.lineCount,
  });
}
const summaryCache = new Map();
async function warmSummary(repo) {
  const p = readingPath(repo) || readmePath(repo);
  if (!p) return;
  const key = `${repo.id}:${p}`;
  if (summaryCache.has(key)) return;
  summaryCache.set(key, (await db.getFileText(repo.id, p)) || '');
}

function openChat() {
  $('app').classList.remove('chat-closed');
}
$('btnChat').addEventListener('click', () => $('app').classList.toggle('chat-closed'));
$('btnChatToggle').addEventListener('click', () => $('app').classList.toggle('chat-closed'));
$('btnChatClose').addEventListener('click', () => $('app').classList.add('chat-closed'));
$('btnChatSize').addEventListener('click', () => {
  settings.chatSize = settings.chatSize === 'large' ? 'normal' : 'large';
  saveSettings();
  applySettings();
});
$('btnChatNew').addEventListener('click', async () => {
  if (chat.busy) return;
  if (chat.conv && !confirm('このファイルの会話を消して、新しく始めますか？')) return;
  await chat.reset();
});

// ---------------------------------------------------------------- 設定ダイアログ
function openSettings() {
  $('setTheme').value = settings.theme;
  $('setLineNumbers').checked = settings.lineNumbers;
  $('setApiKey').value = apiKey();
  $('setModel').value = settings.model;
  $('setEffort').value = settings.effort;
  if (!$('settingsDlg').open) $('settingsDlg').showModal();
}
for (const m of ai.MODELS) {
  const o = document.createElement('option');
  o.value = m.id; o.textContent = m.label;
  $('setModel').append(o);
}
$('btnSettings').addEventListener('click', openSettings);
$('fsDown').addEventListener('click', () => { settings.fontSize = Math.max(9, settings.fontSize - 1); saveSettings(); applySettings(); });
$('fsUp').addEventListener('click', () => { settings.fontSize = Math.min(28, settings.fontSize + 1); saveSettings(); applySettings(); });
$('setTheme').addEventListener('change', (e) => { settings.theme = e.target.value; saveSettings(); applySettings(); });
$('setLineNumbers').addEventListener('change', (e) => { settings.lineNumbers = e.target.checked; saveSettings(); applySettings(); });
$('setModel').addEventListener('change', (e) => { settings.model = e.target.value; saveSettings(); });
$('setEffort').addEventListener('change', (e) => { settings.effort = e.target.value; saveSettings(); });
$('setApiKey').addEventListener('change', (e) => { lsSet(APIKEY_KEY, e.target.value.trim()); });
$('settingsDlg').addEventListener('close', () => { lsSet(APIKEY_KEY, $('setApiKey').value.trim()); });

// ---------------------------------------------------------------- ボタン類
$('btnTree').addEventListener('click', () => { renderTree(); openPanel('treePanel'); });
$('btnBookmarks').addEventListener('click', async () => { await renderBookmarks(); openPanel('bmPanel'); });
$('backdrop').addEventListener('click', closePanels);
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closePanels);
for (const b of document.querySelectorAll('[data-action="pick-folder"]')) b.addEventListener('click', pickFolder);
for (const b of document.querySelectorAll('[data-action="pick-files"]')) b.addEventListener('click', pickFiles);

// ---------------------------------------------------------------- 起動
async function start() {
  applySettings();
  guardSwipeNavigation();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  await refreshRepoSelect();
  const last = lsGet(LAST_REPO_KEY);
  const repos = await db.listRepos();
  const target = repos.find((r) => r.id === last) || repos[0];
  if (target) {
    await openRepo(target.id);
  } else {
    showWelcome(true);
  }
}

start();

// テストや動作確認用に一部を公開
window.__codeReader = { state, viewer, chat, settings };
