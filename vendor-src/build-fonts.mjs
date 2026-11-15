// コード表示用のフォントを app/fonts/ に用意する。
// 使い方: cd vendor-src && npm install && npm run build:fonts
//   - JetBrains Mono（英数字・記号。400 と 700）
//   - M PLUS 1 Code（日本語を含むプログラミング用フォント。400）
//     日本語は約120個の小さなファイルに分かれていて、画面に出てきた文字の分だけ読み込まれる
// どちらも SIL Open Font License。ライセンス文を一緒に置く。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';

const out = new URL('../app/fonts/', import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const pkg = (name) => new URL(`./node_modules/@fontsource/${name}/`, import.meta.url);

let css = '/* 自動生成（vendor-src/build-fonts.mjs）。直接編集しないこと */\n';
const used = new Set();
const take = (name, cssFile) => {
  let text = readFileSync(new URL(cssFile, pkg(name)), 'utf8');
  // woff2 だけを使い、パスをこのフォルダ基準にする
  text = text.replace(/src:\s*url\(\.\/files\/([^)]+\.woff2)\)\s*format\('woff2'\),\s*url\([^)]+\)\s*format\('woff'\);/g, (_, f) => {
    used.add(`${name}/${f}`);
    return `src: url(./${f}) format('woff2');`;
  });
  if (/format\('woff'\)/.test(text)) throw new Error(`${cssFile}: 想定外の書式です`);
  css += text + '\n';
};
take('jetbrains-mono', 'latin-400.css');
take('jetbrains-mono', 'latin-700.css');
take('m-plus-1-code', '400.css');

for (const item of used) {
  const [name, file] = item.split('/');
  copyFileSync(new URL(`files/${file}`, pkg(name)), new URL(file, out));
}
copyFileSync(new URL('LICENSE', pkg('jetbrains-mono')), new URL('LICENSE-JetBrainsMono.txt', out));
copyFileSync(new URL('LICENSE', pkg('m-plus-1-code')), new URL('LICENSE-MPLUS1Code.txt', out));
writeFileSync(new URL('fonts.css', out), css);
console.log(`フォント ${used.size} ファイルを書き出しました（${readdirSync(out).length} ファイル）`);
