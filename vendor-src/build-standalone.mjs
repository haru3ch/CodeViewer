// app/ 一式を、ダブルクリックで開ける1つの HTML ファイルにまとめる。
// 使い方: cd vendor-src && npm install && npm run build:standalone
// 出力: standalone/code-reader.html
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const app = new URL('../app/', import.meta.url);
const out = new URL('../standalone/code-reader.html', import.meta.url);

const js = await build({
  entryPoints: [new URL('js/main.js', app).pathname],
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['safari16', 'chrome110'],
  write: false,
  legalComments: 'eof',
});
const code = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(new URL('style.css', app), 'utf8');
const svg = readFileSync(new URL('icons/icon.svg', app), 'utf8');
const icon = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

let html = readFileSync(new URL('index.html', app), 'utf8');
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html に ${from} が見つかりません`);
  html = html.replace(from, () => to);
};
swap('<link rel="manifest" href="manifest.webmanifest">\n', '');
swap('<link rel="icon" href="icons/icon.svg" type="image/svg+xml">', `<link rel="icon" href="${icon}" type="image/svg+xml">`);
swap('<link rel="apple-touch-icon" href="icons/icon-180.png">\n', '');
// 1ファイル版にはフォントを同梱しない（端末の等幅フォントで表示される）
swap('<link rel="stylesheet" href="fonts/fonts.css">\n', '');
swap('<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
swap('<script type="module" src="js/main.js"></script>', `<script>\n${code}\n</script>`);
html = html.replace('<head>', '<head>\n<!-- 自動生成ファイル（vendor-src/build-standalone.mjs）。直接編集しないこと -->');

writeFileSync(out, html);
console.log(`書き出し: ${out.pathname} (${(html.length / 1024).toFixed(0)} KB)`);
