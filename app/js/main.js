// コード読解リーダー：画面全体のつなぎ込み。
// 画面・機能の切り替えはボタンのタップだけで行い、スワイプには何も割り当てない。

import * as db from './db.js';
import * as files from './files.js';
import * as ai from './ai.js';
import { Viewer } from './viewer.js';
import { Chat } from './chat.js';
import { Finder } from './find.js';
import { listGeminiModels, GEMINI_DEFAULT_MODEL } from './gemini.js';
import { buildOutline, supportsOutline } from './outline.js';
import { marked, DOMPurify } from '../vendor/vendor.js';
import { initDebug, setDebugEnabled, isDebugEnabled, copyText } from './debug.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 設定
const SETTINGS_KEY = 'cr-settings';
const APIKEY_KEY = 'cr-apikey';
const GEMINI_KEY = 'cr-gemini-key';
const LAST_REPO_KEY = 'cr-last-repo';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境 */ } }

const settings = Object.assign(
  {
    fontSize: 14, chatFontSize: 15, theme: 'auto', lineNumbers: true, indentGuides: true, sticky: true, wrap: 'off',
    provider: 'claude', model: ai.DEFAULT_MODEL, effort: 'medium', chatSize: 'normal',
    geminiModel: GEMINI_DEFAULT_MODEL, geminiModels: [],
    excludeDirs: files.DEFAULT_EXCLUDE_DIRS.join(' '),
  },
  JSON.parse(lsGet(SETTINGS_KEY) || '{}'),
);
if (!ai.MODELS.some((m) => m.id === settings.model)) settings.model = ai.DEFAULT_MODEL;
function saveSettings() { lsSet(SETTINGS_KEY, JSON.stringify(settings)); }
function apiKey() { return lsGet(APIKEY_KEY) || ''; }
function geminiKey() { return lsGet(GEMINI_KEY) || ''; }

// ---------------------------------------------------------------- 状態
const state = {
  repo: null,        // 開いているリポジトリ（db の repos のレコード）
  path: null,        // 開いているファイル
  text: '',
  mdMode: false,     // Markdown を整形表示中か
};

const viewer = new Viewer($('codeScroll'), $('codeLines'), $('stickyScope'));
const finder = new Finder(viewer, {
  bar: $('findBar'), input: $('findInput'), count: $('findCount'),
  prev: $('findPrev'), next: $('findNext'), close: $('findClose'),
});

// ---------------------------------------------------------------- 表示設定の反映
function applySettings() {
  const fs = settings.fontSize;
  const lh = Math.round(fs * 1.6);
  document.documentElement.style.setProperty('--fs', `${fs}px`);
  document.documentElement.style.setProperty('--lh', `${lh}px`);
  viewer.setLineHeight(lh);
  if (state.path) viewer.restoreAnchor();
  if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
  $('reader').classList.toggle('no-gutter', !settings.lineNumbers);
  $('reader').classList.toggle('no-guides', !settings.indentGuides);
  viewer.setSticky(settings.sticky);
  applyWrap();
  $('fsVal').textContent = fs;
  document.documentElement.style.setProperty('--chat-fs', `${settings.chatFontSize}px`);
  $('cfsVal').textContent = settings.chatFontSize;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim() || '#1e2229';
  $('app').classList.toggle('chat-large', settings.chatSize === 'large');
}

// 折り返し：「縦向きのときだけ」は向きが変わるたびに切り替える
const portraitMq = window.matchMedia('(orientation: portrait)');
function applyWrap() {
  const on = settings.wrap === 'on' || (settings.wrap === 'portrait' && portraitMq.matches);
  viewer.setWrap(on);
}
portraitMq.addEventListener?.('change', applyWrap);

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
/** 進捗表示。ratio を null にすると「終わりが分からない」動きのバーになる */
function progress(text, ratio, sub = '') {
  const el = $('progress');
  if (text === null) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  $('progressText').textContent = text;
  $('progressSub').textContent = sub;
  $('progress').querySelector('.bar').classList.toggle('indeterminate', ratio === null);
  if (ratio !== null) $('progressBar').style.width = `${Math.round((ratio || 0) * 100)}%`;
}
let importAbort = null;
$('progressCancel').addEventListener('click', () => {
  if (importAbort) importAbort.abort();
  pickerWaiting = false;
  progress(null);
});

// ---------------------------------------------------------------- パネル（開閉はボタンだけ）
function openPanel(id) {
  closePanels();
  $(id).classList.remove('hidden');
  $('backdrop').classList.remove('hidden');
}
function closePanels() {
  for (const id of ['treePanel', 'bmPanel', 'olPanel']) $(id).classList.add('hidden');
  $('backdrop').classList.add('hidden');
}

// ---------------------------------------------------------------- 取り込み
function newRepoId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function importEntries(rootName, entries, pickedAt) {
  pickerWaiting = false;
  if (!entries.length) { progress(null); toast('ファイルが選ばれませんでした'); return; }
  const t0 = performance.now();
  if (pickedAt) console.info(`ブラウザがファイル一覧を渡すまで: ${((t0 - pickedAt) / 1000).toFixed(1)}秒（${entries.length}件）`);
  importAbort = new AbortController();
  const exclude = files.parseExcludeDirs(settings.excludeDirs);
  progress(`ファイルを確認しています… (${entries.length.toLocaleString('ja-JP')}件)`, 0);
  try {
    const { meta, texts, excludedCount } = await files.readEntries(entries, {
      signal: importAbort.signal,
      exclude,
      onProgress: (done, total, path) => {
        progress(`読み込み中… ${done.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')}`, total ? done / total : 1, path);
      },
    });
    const t1 = performance.now();
    console.info(`読み込み: ${((t1 - t0) / 1000).toFixed(1)}秒 テキスト${texts.length}件 / 対象${meta.length}件 / .gitや除外フォルダ${excludedCount}件`);
    if (!texts.length) { toast('読めるテキストファイルがありませんでした'); return; }
    const name = rootName || `読み込み ${new Date().toLocaleString('ja-JP')}`;
    // 同じ名前のフォルダを読み込み直したら、古い方を置き換える（読書位置・しおり・会話は引き継ぐ）
    const old = (await db.listRepos()).find((r) => r.name === name);
    const repo = { id: old ? old.id : newRepoId(), name, importedAt: Date.now(), files: meta };
    if (old) { await db.deleteRepoFiles(old.id); summaryCache.clear(); }
    progress('端末に保存中…', 0);
    await db.saveRepo(repo, texts, (done, total) => progress(`端末に保存中… ${done.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')}`, done / total));
    await db.requestPersist();
    console.info(`保存: ${((performance.now() - t1) / 1000).toFixed(1)}秒`);
    toast(`${texts.length} ファイルを読み込みました${excludedCount ? `（.git など ${excludedCount} 件は除外）` : ''}`, 3500);
    console.info(`取り込み: 「${name}」 テキスト${texts.length}件 / 全${meta.length}件（除外: バイナリ${meta.filter((m) => m.skip === 'binary').length} 大きすぎ${meta.filter((m) => m.skip === 'large').length}）`);
    await openRepo(repo.id, { preferReading: true });
  } catch (err) {
    if (err && err.name === 'AbortError') { toast('読み込みを中止しました'); return; }
    console.error(err);
    toast(`読み込みに失敗しました: ${err.message || err}`, 5000);
  } finally {
    importAbort = null;
    progress(null);
  }
}

// フォルダ選択画面から戻ってから、ブラウザがファイル一覧を渡してくれるまでの待ち時間。
// ファイル数が多い（特に .git が大きい）とここが長いが、ブラウザ側の処理なので進捗は分からない。
let pickerWaiting = false;
let pickerOpenedAt = 0;
function onPickerReturn() {
  if (!pickerWaiting) return;
  setTimeout(() => {
    if (!pickerWaiting) return;
    progress('フォルダの中身を一覧にしています…', null,
      'ブラウザが選んだフォルダ内のファイルを数えています。ファイル数が多い（.git が大きい、node_modules がある等）と時間がかかります。\n長すぎるときは「中止」して、読みたいサブフォルダだけを選んでください。');
  }, 400);
}
window.addEventListener('focus', onPickerReturn);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') onPickerReturn(); });
for (const id of ['dirInput', 'filesInput']) {
  $(id).addEventListener('cancel', () => { pickerWaiting = false; progress(null); });
}

async function pickFolder() {
  closePanels();
  console.info(`フォルダ選択: showDirectoryPicker=${'showDirectoryPicker' in window} webkitdirectory=${files.supportsDirInput()}`);
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      const t = performance.now();
      progress('ファイルを探しています…', null);
      const { rootName, entries } = await files.entriesFromDirHandle(handle, files.parseExcludeDirs(settings.excludeDirs),
        (n) => progress(`ファイルを探しています… ${n.toLocaleString('ja-JP')}件`, null));
      await importEntries(rootName, entries, t);
      return;
    } catch (err) {
      progress(null);
      if (err && err.name === 'AbortError') return;
      // 使えなければ下の方法へ
    }
  }
  if (files.supportsDirInput()) {
    $('dirInput').value = '';
    pickerWaiting = true;
    pickerOpenedAt = performance.now();
    $('dirInput').click();
  } else {
    toast('このブラウザはフォルダ選択に対応していません。「ファイルを複数選んで読み込む」を使ってください。', 5000);
  }
}

function pickFiles() {
  closePanels();
  $('filesInput').value = '';
  pickerWaiting = true;
  pickerOpenedAt = performance.now();
  $('filesInput').click();
}

$('dirInput').addEventListener('change', async (e) => {
  console.info(`フォルダ選択の結果: ${e.target.files.length}件`);
  const { rootName, entries } = files.entriesFromFileList(e.target.files);
  await importEntries(rootName, entries, pickerOpenedAt);
});
$('filesInput').addEventListener('change', async (e) => {
  const { entries } = files.entriesFromFileList(e.target.files);
  await importEntries('', entries, pickerOpenedAt);
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
  await loadTreeMarks();
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

// ファイル一覧に出す印：AIと会話したファイル（💬）と、しおりの数（🔖）
let treeMarks = { chats: new Set(), bms: new Map() };
async function loadTreeMarks() {
  if (!state.repo) return;
  const prefix = `chat:${state.repo.id}:`;
  const chats = new Set((await db.kvKeys(prefix)).map((k) => String(k).slice(prefix.length)));
  const bms = new Map();
  for (const b of await db.listBookmarks(state.repo.id)) bms.set(b.path, (bms.get(b.path) || 0) + 1);
  treeMarks = { chats, bms };
}
/** フォルダ用：中にあるファイルの印を合計する（閉じたフォルダでも、中に印があると分かるように） */
function marksUnder(dir) {
  const pre = `${dir}/`;
  let chats = 0;
  let bms = 0;
  for (const p of treeMarks.chats) if (p.startsWith(pre)) chats++;
  for (const [p, n] of treeMarks.bms) if (p.startsWith(pre)) bms += n;
  return { chats, bms };
}
function badges(chats, bms, isDir) {
  if (!chats && !bms) return null;
  const el = document.createElement('span');
  el.className = 'marks';
  const parts = [];
  if (chats) parts.push(isDir ? `💬${chats}` : '💬');
  if (bms) parts.push(`🔖${bms}`);
  el.textContent = parts.join(' ');
  el.title = [chats ? (isDir ? `AIと会話したファイル ${chats} 件` : 'AIと会話したファイル') : '', bms ? `しおり ${bms} 件` : ''].filter(Boolean).join('・');
  return el;
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
  const m = badges(treeMarks.chats.has(f.path) ? 1 : 0, treeMarks.bms.get(f.path) || 0, false);
  if (m) b.prepend(m);
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
      const mu = marksUnder(full);
      const m = badges(mu.chats, mu.bms, true);
      if (m) sum.append(m);
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
  console.info(`ファイルを開く: ${path}（${text.length}文字）`);
  showWelcome(false);
  $('titleRepo').textContent = state.repo.name;
  $('titlePath').textContent = `‎${path}`;
  $('codeScroll').classList.remove('hidden');
  const t0 = performance.now();
  viewer.render(text, files.langOf(path));
  console.info(`表示: ${viewer.lineCount}行 ${Math.round(performance.now() - t0)}ms`);
  finder.refresh();
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
  viewer.stickyKey = '?';
  viewer.updateSticky();
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
  // チャットが開いて選んだ行が下に隠れたら、見える位置まで送る
  requestAnimationFrame(() => { updateInset(); viewer.jumpTo(r.a, r.b); });
});

// ---------------------------------------------------------------- 重なり（チャット・選択バーがコードに重なる高さ）
function updateInset() {
  const reader = $('reader').getBoundingClientRect();
  let top = reader.bottom;
  for (const id of ['selBar', 'chat']) {
    const el = $(id);
    if (el.classList.contains('hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.height && r.left < reader.right - 1 && r.top < top) top = r.top;   // 横に並んでいるとき（横長画面のチャット）は重なっていない
  }
  const inset = Math.max(0, Math.round(reader.bottom - top));
  $('reader').style.setProperty('--inset', `${inset}px`);
  viewer.bottomInset = inset;
}
const insetObserver = new ResizeObserver(updateInset);
for (const id of ['selBar', 'chat', 'reader']) insetObserver.observe($(id));

// ---------------------------------------------------------------- スワイプで開閉する
// 指に合わせて画面が動く。離したときに、
//   ・全体の 1/3 以上動かしていた（＝画面が 2/3 しか残っていない）か、
//   ・はじくように速く動かしていた
// なら閉じる（開く）。どちらでもなければ元の位置に戻る。
const CLOSE_RATIO = 1 / 3;
const OPEN_RATIO = 1 / 3;
const FLICK_SPEED = 0.5;    // px/ミリ秒。これより速ければ「はじいた」とみなす
const FLICK_MIN = 24;       // はじきと認める最小の移動量(px)

/**
 * handle: 指を置く場所, target: 動かす要素
 * opts.dir(): 今の向き 'left' | 'right' | 'down' | 'up' | null（null なら何もしない）
 * opts.travel(): 端から端までの移動量(px)
 * opts.begin(dir): 動かし始めたとき（必要なら表示を切り替える）。戻り値は開始時のずれ(px)
 * opts.commit(dir) / opts.cancel(dir): 離したときに、しきい値を超えた／超えなかった
 */
function swipePanel(handle, target, opts) {
  let g = null;
  const axisOf = (d) => (d === 'left' || d === 'right' ? 'x' : 'y');
  const signOf = (d) => (d === 'left' || d === 'up' ? -1 : 1);
  const place = (off) => {
    target.style.transform = axisOf(g.dir) === 'x' ? `translateX(${off}px)` : `translateY(${off}px)`;
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const dir = opts.dir();
    if (!dir) return;
    g = { dir, x: e.clientX, y: e.clientY, id: e.pointerId, active: false, base: 0, along: 0, raw: 0, samples: [] };
  });
  handle.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const along = (axisOf(g.dir) === 'x' ? dx : dy) * signOf(g.dir);
    const across = Math.abs(axisOf(g.dir) === 'x' ? dy : dx);
    if (!g.active) {
      if (across > 12 && across > along) { g = null; return; }   // 縦スクロールなど、別の動きだった
      if (along < 12 || along < across * 1.5) return;
      g.active = true;
      g.travel = Math.max(1, opts.travel());
      g.base = opts.begin ? opts.begin(g.dir) || 0 : 0;
      target.classList.add('dragging');
      try { handle.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
    }
    g.along = Math.min(g.travel, Math.max(0, along));
    g.raw = along;
    g.samples.push({ t: e.timeStamp, v: along });
    if (g.samples.length > 8) g.samples.shift();
    place(g.base + g.along * signOf(g.dir));
    e.preventDefault();
  });
  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const cur = g;
    g = null;
    if (!cur.active) return;
    const opening = cur.dir === 'up';
    // 離す直前（約0.1秒）の速さ
    const recent = cur.samples.filter((p) => e.timeStamp - p.t <= 120);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const speed = first && last && last.t > first.t ? (last.v - first.v) / (last.t - first.t) : 0;
    const flick = speed >= FLICK_SPEED && cur.raw >= FLICK_MIN;
    const ok = e.type === 'pointerup' && (flick || cur.along >= cur.travel * (opening ? OPEN_RATIO : CLOSE_RATIO));
    target.classList.remove('dragging');
    // 離したあとは、行き先までアニメーションで動かす
    g = cur;
    place(ok ? cur.base + cur.travel * signOf(cur.dir) : cur.base);
    g = null;
    setTimeout(() => {
      target.style.transform = '';
      if (ok) opts.commit(cur.dir); else if (opts.cancel) opts.cancel(cur.dir);
    }, 170);
    // スワイプの最後に指が離れた場所のボタンが押されたことにならないようにする（直後の1回だけ）
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    handle.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => handle.removeEventListener('click', swallow, { capture: true }), 350);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// サイドバー：中身の上でも、横にスワイプすれば閉じる（縦の動きは一覧のスクロール）
for (const [panelId, dir] of [['treePanel', 'left'], ['bmPanel', 'right'], ['olPanel', 'right']]) {
  const panel = $(panelId);
  swipePanel(panel, panel, {
    dir: () => dir,
    travel: () => panel.offsetWidth,
    commit: closePanels,
  });
}

// チャット：見出しの帯を下にスワイプで閉じ、閉じているときは上にスワイプで開く
const chatSideBySide = window.matchMedia('(min-width: 1000px) and (orientation: landscape)');
{
  const chatEl = $('chat');
  const head = document.querySelector('.chat-head');
  const closed = () => $('app').classList.contains('chat-closed');
  swipePanel(head, chatEl, {
    dir: () => (chatSideBySide.matches ? (closed() ? null : 'right') : (closed() ? 'up' : 'down')),
    travel: () => {
      if (chatSideBySide.matches) return chatEl.offsetWidth;
      if (!closed()) return chatEl.offsetHeight - head.offsetHeight;
      // 開いたときの高さを測る
      $('app').classList.remove('chat-closed');
      const h = chatEl.offsetHeight - head.offsetHeight;
      $('app').classList.add('chat-closed');
      return h;
    },
    begin: (dir) => {
      if (dir !== 'up') return 0;
      // 開いた状態にしてから、見出しだけが見える位置まで下げておき、指に合わせて引き上げる
      $('app').classList.remove('chat-closed');
      return chatEl.offsetHeight - head.offsetHeight;
    },
    commit: (dir) => { if (dir !== 'up') $('app').classList.add('chat-closed'); },
    cancel: (dir) => { if (dir === 'up') $('app').classList.add('chat-closed'); },
  });
}

// ---------------------------------------------------------------- ピンチでの拡大を止める
// （CSS の touch-action と viewport の指定に加えて、iOS Safari 向けにジェスチャーそのものを止める）
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// ---------------------------------------------------------------- 検索・目次
$('btnFind').addEventListener('click', () => {
  if (!state.path) return;
  if (finder.isOpen) { finder.close(); return; }
  if (state.mdMode) setMdMode(false);
  finder.open();
});

function renderOutline() {
  const el = $('olList');
  el.innerHTML = '';
  const empty = (msg) => { const p = document.createElement('p'); p.className = 'bm-empty'; p.textContent = msg; el.append(p); };
  if (!state.path) { empty('ファイルを開くと使えます。'); return; }
  const lang = files.langOf(state.path);
  if (!supportsOutline(lang)) { empty('この種類のファイルは目次に対応していません。'); return; }
  const items = buildOutline(viewer.lines, lang, viewer.cols);
  if (!items.length) { empty('関数やクラスが見つかりませんでした。'); return; }
  // 今見ている位置を含む項目に印を付ける
  const top = viewer.lineAtY(viewer.scrollEl.scrollTop + viewer.stickyHeight());
  let current = -1;
  items.forEach((it, i) => { if (it.line <= top) current = i; });
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ol-item${i === current ? ' current' : ''}`;
    b.style.paddingLeft = `${10 + Math.min(it.depth, 6) * 14}px`;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = `L${it.line}`;
    const k = document.createElement('span'); k.className = 'k'; k.textContent = it.kind;
    b.append(n, k, document.createTextNode(it.name));
    b.addEventListener('click', () => {
      closePanels();
      if (state.mdMode) setMdMode(false);
      viewer.jumpTo(it.line);
    });
    el.append(b);
  });
  el.querySelector('.current')?.scrollIntoView({ block: 'center' });
}
$('btnOutline').addEventListener('click', () => { openPanel('olPanel'); renderOutline(); });

// ---------------------------------------------------------------- しおり
let bmEditing = null;
async function refreshBookmarkMarks() {
  if (!state.repo || !state.path) return;
  const list = (await db.listBookmarks(state.repo.id)).filter((b) => b.path === state.path);
  for (const b of list) await trackBookmark(b);
  viewer.setBookmarks(list.map((b) => ({ line: b.line, lineEnd: b.lineEnd })));
}

/**
 * コードが更新されて行がずれても、しおりが元の行を指し続けるようにする。
 * しおりには付けたときの行の文字（text）を覚えさせてあり、今その行番号にある文字と違っていたら、
 * 同じ文字の行を近い順に探して付け替える。見つからなければ位置はそのままにして「ずれたかも」の印を付ける。
 */
async function trackBookmark(b) {
  const lines = viewer.lines;
  const norm = (t) => (t || '').trim();
  if (b.text === undefined) {
    // 以前の版で付けたしおり：今の行の文字を覚えさせる
    b.text = norm(lines[b.line - 1]);
    await db.updateBookmark(b);
    return;
  }
  if (b.line <= lines.length && norm(lines[b.line - 1]) === b.text) {
    if (b.stale) { b.stale = false; await db.updateBookmark(b); }
    return;
  }
  let found = 0;
  if (b.text) {
    for (let d = 1; d < lines.length && !found; d++) {
      if (b.line - d >= 1 && norm(lines[b.line - d - 1]) === b.text) found = b.line - d;
      else if (b.line + d <= lines.length && norm(lines[b.line + d - 1]) === b.text) found = b.line + d;
    }
  }
  if (found) {
    const len = (b.lineEnd || b.line) - b.line;
    console.info(`しおりを付け替え: ${b.path} L${b.line} → L${found}`);
    b.line = found;
    b.lineEnd = Math.min(lines.length, found + len);
    b.stale = false;
  } else {
    b.stale = true;
    b.line = Math.min(b.line, lines.length);
    b.lineEnd = Math.min(b.lineEnd || b.line, lines.length);
  }
  await db.updateBookmark(b);
}

// ---------------------------------------------------------------- アプリで聞く（サブスク向け）
// 質問文（指示＋ファイル全体＋選択範囲）をコピーし、Claude / ChatGPT のアプリを開いて貼り付けてもらう。
let askTextCache = '';
$('btnAskApp').addEventListener('click', async () => {
  const r = viewer.range();
  if (!r || !state.repo || !state.path) return;
  // クリップボードへの書き込みはタップの直後でないと拒否される端末があるので、ここでは待たずに作る
  askTextCache = ai.buildCopyPrompt({
    context: buildContextFor(state.repo, state.path),
    path: state.path, a: r.a, b: r.b,
    numberedRange: viewer.numbered(r.a, r.b),
  });
  const ok = await copyText(askTextCache);
  console.info(`アプリで聞く: ${rangeLabel(r)} ${askTextCache.length}文字 コピー${ok ? '成功' : '失敗'}`);
  showAskDialog(ok, r);
});
$('askCopyAgain').addEventListener('click', async () => {
  const ok = await copyText(askTextCache);
  toast(ok ? 'コピーしました' : 'コピーできませんでした。下の欄を長押しして全選択→コピーしてください', 4000);
  if (!ok) showAskDialog(false);
});
function showAskDialog(ok, r) {
  const n = askTextCache.length.toLocaleString('ja-JP');
  $('askTitle').textContent = ok ? '質問文をコピーしました' : 'コピーできませんでした';
  $('askMsg').textContent = ok
    ? `${r ? `${state.path} の ${rangeLabel(r)} について、` : ''}ファイル全体を含む質問文（${n}文字）をコピーしました。${askTextCache.length > 150000 ? ' かなり長いので、アプリによっては貼り付けられないことがあります。' : ''}`
    : `下の欄を長押しして「すべてを選択」→「コピー」してください（${n}文字）。`;
  $('askText').classList.toggle('hidden', ok);
  $('askText').value = ok ? '' : askTextCache;
  if (!$('askDlg').open) $('askDlg').showModal();
}

$('btnAddBookmark').addEventListener('click', () => {
  const r = viewer.range();
  if (!r || !state.repo) return;
  bmEditing = { repoId: state.repo.id, path: state.path, line: r.a, lineEnd: r.b, note: '', text: (viewer.lines[r.a - 1] || '').trim(), createdAt: Date.now() };
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
    if (b.stale) {
      const st = document.createElement('span');
      st.className = 'bm-stale';
      st.textContent = '⚠ コードが変わり、元の行が見つかりません（位置がずれているかもしれません）';
      go.append(st);
    }
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
  getSettings: () => (settings.provider === 'gemini'
    ? { provider: 'gemini', apiKey: geminiKey(), model: settings.geminiModel }
    : { provider: 'claude', apiKey: apiKey(), model: settings.model, effort: settings.effort }),
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
    setTimeout(() => $(settings.provider === 'gemini' ? 'setGeminiKey' : 'setApiKey').focus(), 100);
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
  $('setGuides').checked = settings.indentGuides;
  $('setSticky').checked = settings.sticky;
  $('setWrap').value = settings.wrap;
  $('setExclude').value = settings.excludeDirs;
  $('setApiKey').value = apiKey();
  $('setProvider').value = settings.provider;
  $('setGeminiKey').value = geminiKey();
  fillGeminiModels();
  showProviderFields();
  $('setModel').value = settings.model;
  $('setEffort').value = settings.effort;
  $('setDebug').checked = isDebugEnabled();
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
$('cfsDown').addEventListener('click', () => { settings.chatFontSize = Math.max(10, settings.chatFontSize - 1); saveSettings(); applySettings(); });
$('cfsUp').addEventListener('click', () => { settings.chatFontSize = Math.min(24, settings.chatFontSize + 1); saveSettings(); applySettings(); });
// ダイアログの外側（暗い部分）をタップしたら閉じる
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
}
$('setTheme').addEventListener('change', (e) => { settings.theme = e.target.value; saveSettings(); applySettings(); });
$('setLineNumbers').addEventListener('change', (e) => { settings.lineNumbers = e.target.checked; saveSettings(); applySettings(); });
$('setModel').addEventListener('change', (e) => { settings.model = e.target.value; saveSettings(); });
$('setGuides').addEventListener('change', (e) => { settings.indentGuides = e.target.checked; saveSettings(); applySettings(); });
$('setSticky').addEventListener('change', (e) => { settings.sticky = e.target.checked; saveSettings(); applySettings(); });
$('setWrap').addEventListener('change', (e) => { settings.wrap = e.target.value; saveSettings(); applySettings(); });
$('setExclude').addEventListener('change', (e) => { settings.excludeDirs = e.target.value.trim(); saveSettings(); });
$('setExcludeReset').addEventListener('click', () => {
  settings.excludeDirs = files.DEFAULT_EXCLUDE_DIRS.join(' ');
  $('setExclude').value = settings.excludeDirs;
  saveSettings();
});
$('setDebug').addEventListener('change', (e) => setDebugEnabled(e.target.checked));
$('setEffort').addEventListener('change', (e) => { settings.effort = e.target.value; saveSettings(); });
$('setApiKey').addEventListener('change', (e) => { lsSet(APIKEY_KEY, e.target.value.trim()); });

// ---- Gemini の設定
function showProviderFields() {
  $('geminiFields').classList.toggle('hidden', settings.provider !== 'gemini');
  $('claudeFields').classList.toggle('hidden', settings.provider === 'gemini');
}
function fillGeminiModels() {
  const sel = $('setGeminiModel');
  sel.innerHTML = '';
  const list = settings.geminiModels.length ? settings.geminiModels : [{ id: GEMINI_DEFAULT_MODEL, label: `${GEMINI_DEFAULT_MODEL}（既定）` }];
  if (!list.some((m) => m.id === settings.geminiModel)) list.unshift({ id: settings.geminiModel, label: settings.geminiModel });
  for (const m of list) {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label;
    sel.append(o);
  }
  sel.value = settings.geminiModel;
}
async function refreshGeminiModels() {
  const key = geminiKey();
  if (!key) { toast('先に Gemini の APIキーを入れてください'); return; }
  $('geminiRefresh').disabled = true;
  try {
    const list = await listGeminiModels(key);
    if (!list.length) { toast('使えるモデルが見つかりませんでした'); return; }
    settings.geminiModels = list;
    // 今の選択が一覧に無ければ、先頭（Flash 系）にする
    if (!list.some((m) => m.id === settings.geminiModel)) settings.geminiModel = list[0].id;
    saveSettings();
    fillGeminiModels();
    toast(`${list.length} 個のモデルが使えます`);
  } catch (err) {
    console.error('Geminiモデル一覧の取得に失敗:', err);
    toast(String(err.message || err), 5000);
  } finally {
    $('geminiRefresh').disabled = false;
  }
}
$('setProvider').addEventListener('change', (e) => { settings.provider = e.target.value; saveSettings(); showProviderFields(); });
$('setGeminiKey').addEventListener('change', async (e) => {
  lsSet(GEMINI_KEY, e.target.value.trim());
  if (e.target.value.trim()) await refreshGeminiModels();
});
$('setGeminiModel').addEventListener('change', (e) => { settings.geminiModel = e.target.value; saveSettings(); });
$('geminiRefresh').addEventListener('click', refreshGeminiModels);
$('settingsDlg').addEventListener('close', () => { lsSet(APIKEY_KEY, $('setApiKey').value.trim()); lsSet(GEMINI_KEY, $('setGeminiKey').value.trim()); });

// ---------------------------------------------------------------- ボタン類
$('btnTree').addEventListener('click', async () => { await loadTreeMarks(); renderTree(); openPanel('treePanel'); });
$('btnBookmarks').addEventListener('click', async () => { await renderBookmarks(); openPanel('bmPanel'); });
$('backdrop').addEventListener('click', closePanels);
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closePanels);
for (const b of document.querySelectorAll('[data-action="pick-folder"]')) b.addEventListener('click', pickFolder);
for (const b of document.querySelectorAll('[data-action="pick-files"]')) b.addEventListener('click', pickFiles);

// ---------------------------------------------------------------- 起動
async function start() {
  initDebug();
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
window.__codeReader = { state, viewer, chat, settings, finder };
