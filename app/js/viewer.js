// コード表示部。
// - 1行 = 1表示行（折り返さない）。長い行は横スクロールで読む
// - 行の高さを整数pxで固定しているので「スクロール量 ÷ 行の高さ」で今の行番号が正確に分かる
// - 行をタップ → 開始行、もう一度タップ → 終了行（ドラッグ選択の代わり）

import { hljs } from '../vendor/vendor.js';

const HIGHLIGHT_LIMIT = 600_000; // これより大きいファイルは色付けしない（重くなるため）

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * highlight.js の出力（複数行にまたがる <span> を含む）を行ごとに分ける。
 * 行末で開いている span を閉じ、次の行の頭で開き直すので、各行が単独で正しい HTML になる。
 */
function splitHighlighted(html) {
  const lines = [];
  const stack = [];
  let cur = '';
  const re = /<span[^>]*>|<\/span>|\n|[^<\n]+/g;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    if (t === '\n') {
      lines.push(cur + '</span>'.repeat(stack.length));
      cur = stack.join('');
    } else if (t.startsWith('<span')) {
      stack.push(t); cur += t;
    } else if (t === '</span>') {
      stack.pop(); cur += t;
    } else {
      cur += t;
    }
  }
  lines.push(cur + '</span>'.repeat(stack.length));
  return lines;
}

export class Viewer {
  constructor(scrollEl, linesEl) {
    this.scrollEl = scrollEl;
    this.linesEl = linesEl;
    this.lineCount = 0;
    this.lines = [];
    this.sel = null;           // { a, b, done } a: 開始行, b: 終了行, done: 終了行まで決まったか
    this.bookmarkLines = new Set();
    this.lineHeight = 22;
    this.onSelectionChange = () => {};
    this.onScrollIdle = () => {};

    this.linesEl.addEventListener('click', (e) => {
      // テキストを長押しで選んでいる最中のタップは行選択にしない
      const ws = window.getSelection && window.getSelection();
      if (ws && !ws.isCollapsed && String(ws).length > 0) return;
      const row = e.target.closest('.ln');
      if (!row) return;
      this.tapLine(Number(row.dataset.n));
    });

    let t = 0;
    this.scrollEl.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => this.onScrollIdle(this.topLine(), this.scrollEl.scrollLeft), 250);
    }, { passive: true });
  }

  setLineHeight(px) {
    this.lineHeight = px;
  }

  /** ファイルを表示する */
  render(text, lang) {
    const raw = text.split('\n');
    // 末尾の改行で空行が1つ増えるのを防ぐ
    if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
    this.lines = raw;
    this.lineCount = raw.length;

    let htmlLines;
    if (text.length <= HIGHLIGHT_LIMIT && lang && lang !== 'plaintext' && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(raw.join('\n'), { language: lang, ignoreIllegals: true }).value;
        htmlLines = splitHighlighted(out);
      } catch {
        htmlLines = raw.map(escapeHtml);
      }
    } else {
      htmlLines = raw.map(escapeHtml);
    }

    const digits = String(this.lineCount).length;
    this.linesEl.style.setProperty('--gutter-w', `${Math.max(3, digits)}ch`);
    const parts = new Array(htmlLines.length);
    for (let i = 0; i < htmlLines.length; i++) {
      const n = i + 1;
      parts[i] = `<div class="ln" data-n="${n}"><span class="g">${n}</span><span class="s">${htmlLines[i] || ' '}</span></div>`;
    }
    this.linesEl.innerHTML = parts.join('');
    this.sel = null;
    this.applyBookmarks();
  }

  row(n) {
    return this.linesEl.children[n - 1] || null;
  }

  topLine() {
    return Math.floor(this.scrollEl.scrollTop / this.lineHeight + 0.5) + 1;
  }

  /** n行目が画面の上の方に来るようにスクロールする */
  scrollToLine(n, { left = null, margin = 0 } = {}) {
    const target = Math.max(0, (n - 1 - margin) * this.lineHeight);
    this.scrollEl.scrollTop = target;
    if (left !== null) this.scrollEl.scrollLeft = left;
  }

  /** n行目（〜m行目）へ移動して一瞬光らせる */
  jumpTo(n, m = n) {
    n = Math.min(Math.max(1, n), this.lineCount);
    m = Math.min(Math.max(n, m), this.lineCount);
    const viewLines = Math.floor(this.scrollEl.clientHeight / this.lineHeight);
    const visibleTop = this.topLine();
    const inView = n >= visibleTop && m < visibleTop + viewLines - 1;
    if (!inView) this.scrollToLine(n, { margin: Math.min(3, Math.floor(viewLines / 4)) });
    this.scrollEl.scrollLeft = 0;
    for (let i = n; i <= m; i++) {
      const r = this.row(i);
      if (!r) continue;
      r.classList.remove('flash');
      void r.offsetWidth; // アニメーションをやり直す
      r.classList.add('flash');
    }
  }

  tapLine(n) {
    if (!this.sel || this.sel.done) {
      this.setSelection({ a: n, b: n, done: false });
    } else {
      this.setSelection({ a: Math.min(this.sel.a, n), b: Math.max(this.sel.a, n), done: true });
    }
  }

  setSelection(sel) {
    const prev = this.sel;
    if (prev) for (let i = prev.a; i <= prev.b; i++) this.row(i)?.classList.remove('sel', 'pending');
    this.sel = sel;
    if (sel) {
      const cls = sel.done ? 'sel' : 'pending';
      for (let i = sel.a; i <= sel.b; i++) this.row(i)?.classList.add(cls);
    }
    this.onSelectionChange(sel);
  }

  clearSelection() { this.setSelection(null); }

  /** 選択範囲（終了行未定なら開始行だけ）を返す */
  range() {
    if (!this.sel) return null;
    return { a: this.sel.a, b: this.sel.b };
  }

  setBookmarks(lines) {
    this.bookmarkLines = new Set(lines);
    this.applyBookmarks();
  }

  applyBookmarks() {
    for (const el of this.linesEl.querySelectorAll('.ln.bm')) el.classList.remove('bm');
    for (const n of this.bookmarkLines) this.row(n)?.classList.add('bm');
  }

  /** 行範囲のテキスト（行番号付き） */
  numbered(a = 1, b = this.lineCount) {
    const w = String(this.lineCount).length;
    const out = [];
    for (let i = a; i <= b; i++) out.push(`${String(i).padStart(w, ' ')}| ${this.lines[i - 1] ?? ''}`);
    return out.join('\n');
  }
}
