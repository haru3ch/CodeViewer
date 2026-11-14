# READING.md — コード読解リーダーの読み方

## 目的
iPad / Android で、clone 済みフォルダのコードを「折り返さず・横スワイプで画面が変わらず」に読み、
選んだ行範囲を AI（Claude）に日本語で解説してもらう、読み専用の PWA。

## 構成
```
app/
  index.html        画面の骨組み（ヘッダー／コード表示／選択バー／チャット／パネル／ダイアログ）
  style.css         見た目。折り返しなし・行の高さ固定・スワイプ遷移の抑止もここ
  js/main.js        全体のつなぎ込み（起動、ファイルを開く、パネル、設定、しおり）
  js/viewer.js      コード表示と行選択
  js/files.js       フォルダの読み込み、.git・バイナリの除外、文字コード判定、拡張子→言語
  js/db.js          端末内保存（IndexedDB）
  js/ai.js          Claude への問い合わせ（プロンプトとストリーミング）
  js/chat.js        チャット欄（会話の保持、Markdown表示、行番号リンク）
  sw.js             オフライン用キャッシュ
  vendor/vendor.js  外部ライブラリ一式（vendor-src からビルド）
```

## 読む順番
1. `app/js/main.js` の末尾 `start()` → 起動の流れ
2. `app/js/viewer.js` → 折り返しなし表示と、タップ2回での範囲選択
3. `app/js/chat.js` の `explain()` / `send()` → 「解説して」を押したときの流れ
4. `app/js/ai.js` の `ask()` → 実際に API へ送る中身
5. `app/js/files.js` の `readEntries()` → フォルダ読み込み

## 主要な関数と設計意図
- `Viewer.render()`（viewer.js）: highlight.js の出力を `splitHighlighted()` で行ごとに切り、1行1要素にする。
  複数行コメントのように行をまたぐ色付けも、行末で閉じて次行で開き直すので崩れない。
- 行の高さを整数 px に固定（main.js `applySettings()`）。「スクロール量 ÷ 行の高さ」で今の行番号が正確に出るので、
  読書位置の保存・復元が単純になる。
- `guardSwipeNavigation()`（main.js）: 履歴を1つ積み、戻る操作が来たら積み直すだけ。
  スワイプで画面・機能が切り替わらないようにするため（仕様 §3.1）。CSS の `overscroll-behavior` も同じ目的。
- `buildContext()`（ai.js）: リポジトリのファイル一覧・READING.md・対象ファイル全体（行番号付き）を
  system プロンプトの2つ目に入れ、`cache_control` を付ける。同じファイルで質問を続ける間はキャッシュが効く。
- ファイル本文は行番号付きで渡す。AI が「L12」と正しい行番号で引用でき、回答内の `L12` はタップで移動できる。
- 取り込みはフォルダを選ぶだけ。clone や GitHub 認証はしない（仕様 §3.2 / §5）。
