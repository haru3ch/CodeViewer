// 使い方: cd vendor-src && npm install && npm run build
import { build } from 'esbuild';
await build({
  entryPoints: ['entry.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['safari16', 'chrome110'],
  outfile: '../app/vendor/vendor.js',
  legalComments: 'eof',
  logLevel: 'info',
});
