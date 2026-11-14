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

/** .git フォルダの中か */
function inGitDir(path) {
  return path.split('/').some((seg) => seg === '.git');
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

/**
 * 選ばれたファイル群を読む。
 * entries: [{path, file}]（path はフォルダからの相対パス）
 * 戻り値: { meta: [{path, size, skip?}], texts: [{path, text}] }
 */
export async function readEntries(entries, onProgress) {
  const meta = [];
  const texts = [];
  const list = entries.filter((e) => !inGitDir(e.path));
  let done = 0;
  for (const { path, file } of list) {
    done++;
    if (onProgress && (done % 10 === 0 || done === list.length)) onProgress(done, list.length, path);
    const size = file.size;
    if (BINARY_EXT.has(extOf(path))) { meta.push({ path, size, skip: 'binary' }); continue; }
    if (size > MAX_FILE_BYTES) { meta.push({ path, size, skip: 'large' }); continue; }
    let buf;
    try { buf = await file.arrayBuffer(); } catch { meta.push({ path, size, skip: 'error' }); continue; }
    const bytes = new Uint8Array(buf);
    if (looksBinary(bytes)) { meta.push({ path, size, skip: 'binary' }); continue; }
    let text = decode(buf);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    meta.push({ path, size });
    texts.push({ path, text });
  }
  meta.sort((a, b) => a.path.localeCompare(b.path));
  return { meta, texts };
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
export async function entriesFromDirHandle(dirHandle) {
  const entries = [];
  async function walk(handle, prefix) {
    for await (const [name, child] of handle.entries()) {
      if (name === '.git') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.kind === 'directory') await walk(child, path);
      else entries.push({ path, file: await child.getFile() });
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
