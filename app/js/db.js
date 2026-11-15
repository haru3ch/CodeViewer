// 端末内保存（IndexedDB）。サーバーには何も送らない。
//   repos     : 読み込んだフォルダ1つ = 1件。ファイル一覧（パス・サイズ・除外理由）も持つ
//   files     : ファイル本文。キーは [repoId, path]
//   bookmarks : しおり（行メモ）
//   kv        : 読書位置・最後に開いたファイル・会話履歴などの小さな値

const DB_NAME = 'code-reader';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('repos', { keyPath: 'id' });
      const files = db.createObjectStore('files', { keyPath: ['repoId', 'path'] });
      files.createIndex('repoId', 'repoId');
      const bm = db.createObjectStore('bookmarks', { keyPath: 'id', autoIncrement: true });
      bm.createIndex('repoId', 'repoId');
      db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

/** フォルダの情報（名前とファイル一覧）を保存する */
export async function putRepo(repo) {
  const db = await openDb();
  const tx = db.transaction(['repos'], 'readwrite');
  tx.objectStore('repos').put(repo);
  await txDone(tx);
}

/** ファイルの本文をまとめて保存する。files: [{path, text}] */
export async function putFiles(repoId, files) {
  if (!files.length) return;
  const db = await openDb();
  const tx = db.transaction(['files'], 'readwrite');
  const fs = tx.objectStore('files');
  for (const f of files) fs.put({ repoId, path: f.path, text: f.text });
  await txDone(tx);
}

export async function listRepos() {
  const repos = await promisify((await store('repos')).getAll());
  return repos.sort((a, b) => b.importedAt - a.importedAt);
}

export async function getRepo(id) {
  return promisify((await store('repos')).get(id));
}

export async function getFileText(repoId, path) {
  const rec = await promisify((await store('files')).get([repoId, path]));
  return rec ? rec.text : null;
}

async function deleteByIndex(tx, storeName, repoId) {
  const idx = tx.objectStore(storeName).index('repoId');
  await new Promise((resolve, reject) => {
    const req = idx.openKeyCursor(IDBKeyRange.only(repoId));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      tx.objectStore(storeName).delete(cur.primaryKey);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** 読み込み直しのとき用：本文だけ消す（読書位置・しおり・会話は残す） */
export async function deleteRepoFiles(repoId) {
  const db = await openDb();
  const tx = db.transaction(['files'], 'readwrite');
  await deleteByIndex(tx, 'files', repoId);
  await txDone(tx);
}

export async function deleteRepo(repoId) {
  const db = await openDb();
  const tx = db.transaction(['repos', 'files', 'bookmarks', 'kv'], 'readwrite');
  tx.objectStore('repos').delete(repoId);
  await deleteByIndex(tx, 'files', repoId);
  await deleteByIndex(tx, 'bookmarks', repoId);
  // kv はキーの接頭辞で消す
  const kv = tx.objectStore('kv');
  const prefixRange = (p) => IDBKeyRange.bound(p, p + '￿');
  for (const p of [`pos:${repoId}:`, `chat:${repoId}:`, `mdmode:${repoId}:`, `last:${repoId}`]) kv.delete(prefixRange(p));
  await txDone(tx);
}

export async function kvGet(key) {
  const rec = await promisify((await store('kv')).get(key));
  return rec ? rec.value : undefined;
}

export async function kvSet(key, value) {
  const s = await store('kv', 'readwrite');
  await promisify(s.put({ key, value }));
}

/** 指定した接頭辞で始まるキーの一覧（例: 'chat:r123:' → そのフォルダで会話があるファイル） */
export async function kvKeys(prefix) {
  const s = await store('kv');
  return promisify(s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')));
}

export async function kvDelete(key) {
  const s = await store('kv', 'readwrite');
  await promisify(s.delete(key));
}

export async function addBookmark(bm) {
  const s = await store('bookmarks', 'readwrite');
  return promisify(s.add(bm));
}

export async function updateBookmark(bm) {
  const s = await store('bookmarks', 'readwrite');
  return promisify(s.put(bm));
}

export async function deleteBookmark(id) {
  const s = await store('bookmarks', 'readwrite');
  return promisify(s.delete(id));
}

export async function listBookmarks(repoId) {
  const s = await store('bookmarks');
  const list = await promisify(s.index('repoId').getAll(IDBKeyRange.only(repoId)));
  return list.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/** ブラウザが容量不足時に勝手に消さないようお願いする（Safari では効かないこともある） */
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch { /* 無視 */ }
}
