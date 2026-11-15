// フォルダの取り込み（git clone 済みフォルダを端末から選ぶ）と、拡張子→言語の判定。
// アプリ側で clone や GitHub 認証はしない。選ばれたファイルを読んで端末内に保存するだけ。

const MAX_FILE_BYTES = 2 * 1024 * 1024; // これより大きいファイルは本文を保存しない（一覧には「大きすぎ」と出す）

// 中身を見なくてもバイナリと分かる拡張子
const BINARY_EXT = new Set(`
png jpg jpeg gif bmp tga psd exr hdr dds ico icns webp tif tiff heic svgz ktx ktx2 astc
fbx blend blend1 max mb abc usdc usdz glb 3ds uasset umap upk pak ubulk uexp spp sbsar sbs tx
zip 7z rar gz tgz bz2 xz zst tar lz4 jar war apk ipa dmg iso
exe dll so dylib lib a o obj.bin pdb ilk exp class pyc pyo pyd wasm node bin dat db sqlite sqlite3 mdb
pdf doc docx xls xlsx ppt pptx key numbers pages
mp3 wav ogg flac aac m4a aiff mp4 mov avi mkv webm wmv flv m4v
ttf otf woff woff2 eot
npy npz pkl pickle h5 hdf5 pt pth onnx ckpt safetensors tflite
`.trim().split(/\s+/));

/** 拡張子・ファイル名 → highlight.js の言語名 */
const EXT_LANG = {
  py: 'python', pyw: 'python', pyi: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp', ipp: 'cpp', cs: 'csharp',
  hlsl: 'hlsl', hlsli: 'hlsl', fx: 'hlsl', fxh: 'hlsl', usf: 'hlsl', ush: 'hlsl', cginc: 'hlsl', compute: 'hlsl', shader: 'hlsl',
  glsl: 'glsl', vert: 'glsl', frag: 'glsl', geom: 'glsl', comp: 'glsl', vs: 'glsl', fs: 'glsl',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  json: 'json', jsonc: 'json', webmanifest: 'json', uplugin: 'json', uproject: 'json',
  yml: 'yaml', yaml: 'yaml',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', xaml: 'xml', ui: 'xml', plist: 'xml',
  css: 'css',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  ini: 'ini', cfg: 'ini', toml: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini',
  lua: 'lua',
  mel: 'cpp', // Maya MEL は C 系の見た目で十分
};
const NAME_LANG = {
  'makefile': 'bash', 'dockerfile': 'bash', '.gitignore': 'bash', '.gitattributes': 'bash', '.env': 'ini',
  'cmakelists.txt': 'bash', '.bashrc': 'bash', '.zshrc': 'bash',
};

export function langOf(path) {
  const name = path.split('/').pop().toLowerCase();
  if (NAME_LANG[name]) return NAME_LANG[name];
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  return EXT_LANG[name.slice(dot + 1)] || 'plaintext';
}

export function isMarkdown(path) { return langOf(path) === 'markdown'; }

function extOf(path) {
  const name = path.split('/').pop().toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/** 文字コードを推定して文字列にする（UTF-8 → だめなら Shift_JIS） */
function decode(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    try { return new TextDecoder('shift_jis').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
  }
}

function looksBinary(bytes) {
  // UTF-16 の BOM 付きはテキスト扱い
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** 取り込まないフォルダ（既定）。依存ライブラリやビルド生成物など、読む対象でないのに数が多いもの */
export const DEFAULT_EXCLUDE_DIRS = [
  'node_modules', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.idea', '.vs', '.vscode-test', '.next', '.nuxt', '.cache', '.gradle',
  'Intermediate', 'Binaries', 'Saved', 'DerivedDataCache', // Unreal Engine の生成物
  'Library', 'Temp', 'Logs', 'obj', // Unity / Visual Studio の生成物
];

/** 「a, b c」のような文字列 → 除外フォルダ名の集合（大文字小文字は区別しない） */
export function parseExcludeDirs(text) {
  return new Set(String(text || '').split(/[\s,、]+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
}

/** パスのどこかに .git または除外フォルダが含まれるか */
export function isExcludedPath(path, excludeSet) {
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i].toLowerCase();
    if (seg === '.git' || excludeSet.has(seg)) return true;
  }
  return parts[parts.length - 1] === '.git';
}

// 重い処理の途中でときどき画面に描画の機会を渡す（これをしないと進捗バーが止まって見える）
let lastYield = 0;
async function maybeYield() {
  const now = performance.now();
  if (now - lastYield < 40) return;
  await new Promise((r) => setTimeout(r, 0));
  lastYield = performance.now();
}

/** 中身を読まなくても分かる「読み込まない理由」（拡張子・大きさ）。問題なければ undefined */
export function quickSkip(path, size) {
  if (BINARY_EXT.has(extOf(path))) return 'binary';
  if (size !== undefined && size > MAX_FILE_BYTES) return 'large';
  return undefined;
}

/**
 * ファイル1つを読んで文字列にする。
 * entry: { path, file } または { path, handle }（handle はフォルダ選択 API のファイル）
 * 戻り値: { text } か、読み込まない場合は { skip: 'binary' | 'large' | 'error' }
 */
export async function readEntry(entry) {
  let file;
  try { file = entry.file || await entry.handle.getFile(); } catch { return { skip: 'error' }; }
  if (file.size > MAX_FILE_BYTES) return { skip: 'large', size: file.size };
  let buf;
  try { buf = await file.arrayBuffer(); } catch { return { skip: 'error' }; }
  if (looksBinary(new Uint8Array(buf))) return { skip: 'binary', size: file.size };
  let text = decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text: text.replace(/\r\n?/g, '\n'), size: file.size };
}

/** 一覧から .git と除外フォルダを取り除く（件数が多くても画面が固まらないよう、ときどき休む） */
export async function filterEntries(entries, exclude) {
  const list = [];
  let excludedCount = 0;
  for (let i = 0; i < entries.length; i++) {
    if (isExcludedPath(entries[i].path, exclude)) excludedCount++;
    else list.push(entries[i]);
    if (i % 2000 === 0) await maybeYield();
  }
  return { list, excludedCount };
}

/** <input webkitdirectory> の FileList → {rootName, entries} */
export function entriesFromFileList(fileList) {
  const files = Array.from(fileList);
  let rootName = '';
  const entries = files.map((file) => {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    if (parts.length > 1) {
      if (!rootName) rootName = parts[0];
      return { path: parts.slice(1).join('/'), file };
    }
    return { path: rel, file };
  });
  return { rootName, entries };
}

/** File System Access API（showDirectoryPicker）のフォルダを再帰で集める。.git には入らない */
export async function entriesFromDirHandle(dirHandle, exclude = new Set(), onCount) {
  const entries = [];
  async function walk(handle, prefix) {
    for await (const [name, child] of handle.entries()) {
      if (name === '.git' || (child.kind === 'directory' && exclude.has(name.toLowerCase()))) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === 'directory') await walk(child, path);
      else {
        // ここではファイルを開かない（名前だけ集める）。中身は表示するとき・裏での保存のときに読む
        entries.push({ path, handle: child });
        if (onCount && entries.length % 200 === 0) { onCount(entries.length); await maybeYield(); }
      }
    }
  }
  await walk(dirHandle, '');
  return { rootName: dirHandle.name, entries };
}

/** <input webkitdirectory> がこのブラウザで使えるか */
export function supportsDirInput() {
  const input = document.createElement('input');
  return 'webkitdirectory' in input;
}
