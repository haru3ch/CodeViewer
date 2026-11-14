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

const TAB = 4;

/** 行頭の空白（スペース・タブ）の幅を桁数で返す。タブは4桁ごとの位置まで進む */
function indentCols(prefix) {
  let col = 0;
  for (const c of prefix) col = c === '\t' ? (Math.floor(col / TAB) + 1) * TAB : col + 1;
  return col;
}

/**
 * ハイライト済みの1行から、行頭の空白 n 文字を取り除く（タグは残す）。
 * インデントは別の要素で表示し、折り返したときも正しい位置に揃えるため。
 */
function stripLeading(html, n) {
  if (!n) return html;
  let out = '';
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const j = html.indexOf('>', i);
      out += html.slice(i, j + 1);
      i = j + 1;
    } else if (n > 0 && (html[i] === ' ' || html[i] === '\t')) {
      n--; i++;
    } else {
      out += html.slice(i);
      break;
    }
  }
  return out;
}

/** ファイル全体のインデントの単位（2 か 4）を推定する。罫線の間隔に使う */
function guessIndentUnit(cols, raw) {
  if (raw.some((l) => l.startsWith('\t'))) return TAB;
  const used = cols.filter((c) => c > 0);
  if (!used.length) return 4;
  if (used.every((c) => c % 4 === 0)) return 4;
  const twos = used.filter((c) => c % 2 === 0).length;
  return twos / used.length > 0.8 ? 2 : 4;
}

const STICKY_MAX = 5;

/** 行の見た目の幅（桁）。全角文字は2桁、タブは4桁として多めに見積もる */
function displayCols(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    n += c === 9 ? TAB : c > 0x2e7f ? 2 : 1;
  }
  return n;
}

export class Viewer {
  constructor(scrollEl, linesEl, stickyEl = null) {
    this.scrollEl = scrollEl;
    this.linesEl = linesEl;
    this.stickyEl = stickyEl;   // スクロールしても上に残す「今いるブロックの先頭行」の表示先
    this.stickyOn = true;
    this.stickyKey = '';
    this.parent = new Int32Array(0);
    this.cols = [];
    this.blank = [];
    this.lineCount = 0;
    this.lines = [];
    this.sel = null;           // { a, b, done } a: 開始行, b: 終了行, done: 終了行まで決まったか
    this.bookmarkRanges = [];
    this.bottomInset = 0;      // 下に重なっているチャット・選択バーの高さ（その下の行は「見えていない」扱いにする）
    this.lineHeight = 22;
    this.wrap = false;         // 折り返し表示中か（行の高さが行ごとに変わる）
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

    // 今見ている行（画面の幅が変わって折り返し位置がずれても、この行を保つ）
    this.anchor = 1;
    let t = 0;
    let stickyQueued = false;
    this.scrollEl.addEventListener('scroll', () => {
      if (this.lineCount && !this.restoring) this.anchor = this.topLine();
      if (!stickyQueued) {
        stickyQueued = true;
        requestAnimationFrame(() => { stickyQueued = false; this.updateSticky(); });
      }
      clearTimeout(t);
      t = setTimeout(() => this.onScrollIdle(this.topLine(), this.scrollEl.scrollLeft), 250);
    }, { passive: true });

    // 画面の回転・分割表示などで幅が変わったら、見ていた行へ戻す
    let lastW = 0;
    new ResizeObserver(() => {
      const w = this.scrollEl.clientWidth;
      if (w === lastW || !this.lineCount) { lastW = w; return; }
      lastW = w;
      this.restoreAnchor();
    }).observe(this.scrollEl);

    if (this.stickyEl) {
      this.stickyEl.addEventListener('click', (e) => {
        const row = e.target.closest('.ln');
        if (row) this.jumpTo(Number(row.dataset.n));
      });
    }
  }

  // ---------------------------------------------------------------- スティッキー表示（ブロックの先頭行）
  /**
   * 各行の「親の行」をインデントから求める（自分より浅い、直前の行）。
   * Python の def / if、{ } を使う言語の関数や if など、言語を問わず使える。
   */
  computeScopes(nextNonBlank) {
    const n = this.lineCount;
    const parent = new Int32Array(n).fill(-1);
    const stack = [];
    for (let i = 0; i < n; i++) {
      const eff = this.blank[i] ? nextNonBlank[i] : this.cols[i];
      while (stack.length && this.cols[stack[stack.length - 1]] >= eff) stack.pop();
      parent[i] = stack.length ? stack[stack.length - 1] : -1;
      if (!this.blank[i]) stack.push(i);
    }
    this.parent = parent;
  }

  /** 親の行が「)」「]」で始まる行や「{」だけの行なら、その文の本当の先頭行（def foo( など）に置き換える */
  headOf(j) {
    const t = this.lines[j].trim();
    if (!(/^[)\]]/.test(t) || t === '{')) return j;
    for (let k = j - 1; k >= 0; k--) {
      if (this.blank[k]) continue;
      if (this.cols[k] < this.cols[j]) break;
      if (this.cols[k] === this.cols[j]) return /^[)\]]/.test(this.lines[k].trim()) || this.lines[k].trim() === '{' ? this.headOf(k) : k;
    }
    return j;
  }

  /** i（0始まり）を囲んでいるブロックの先頭行を、外側から順に返す（0始まりの行番号） */
  scopeChain(i) {
    const chain = [];
    for (let p = this.parent[i]; p >= 0; p = this.parent[p]) {
      const h = this.headOf(p);
      if (chain[chain.length - 1] !== h) chain.push(h);
    }
    chain.reverse();
    // 深すぎるときは外側2つ＋内側3つに絞る
    return chain.length > STICKY_MAX ? [...chain.slice(0, 2), ...chain.slice(-(STICKY_MAX - 2))] : chain;
  }

  setSticky(on) {
    this.stickyOn = on;
    this.updateSticky();
  }

  stickyHeight() {
    return this.stickyEl && !this.stickyEl.hidden ? this.stickyEl.offsetHeight : 0;
  }

  updateSticky() {
    const el = this.stickyEl;
    if (!el) return;
    let chain = [];
    if (this.stickyOn && this.lineCount && !this.scrollEl.classList.contains('hidden')) {
      // 上に重ねる行数を1行ずつ増やし、「重ねた行のすぐ下に見えている行」を囲むブロックの数と釣り合うところで止める。
      // こうすると、表示されるのは常に「いま一番上に見えている行」が属するブロックになる。
      const st = this.scrollEl.scrollTop;
      let count = 0;
      for (;;) {
        chain = this.scopeChain(this.lineAtY(st + count * this.lineHeight) - 1);
        if (chain.length <= count) break;
        count++;
      }
    }
    const key = chain.join(',');
    if (key === this.stickyKey) return;
    this.stickyKey = key;
    el.hidden = chain.length === 0;
    el.innerHTML = chain.map((i) => `<div class="ln" data-n="${i + 1}">${this.row(i + 1).innerHTML}</div>`).join('');
  }

  /** スクロール位置 y にある行番号 */
  lineAtY(y) {
    if (!this.lineCount) return 1;
    if (!this.wrap) return Math.min(this.lineCount, Math.max(1, Math.floor(y / this.lineHeight + 0.5) + 1));
    // 折り返し時は行の高さがばらばらなので、行の位置を二分探索する
    let lo = 1;
    let hi = this.lineCount;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.row(mid).offsetTop <= y + 2) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  restoreAnchor() {
    this.restoring = true;
    this.scrollToLine(this.anchor);
    requestAnimationFrame(() => { this.restoring = false; });
  }

  setLineHeight(px) {
    this.lineHeight = px;
  }

  /** 折り返しの切り替え。見ていた行を保ったまま切り替える */
  setWrap(on) {
    if (on === this.wrap) return;
    this.wrap = on;
    this.linesEl.classList.toggle('wrap', on);
    this.scrollEl.classList.toggle('wrapping', on);
    if (this.lineCount) { this.scrollEl.scrollLeft = 0; this.restoreAnchor(); }
    this.stickyKey = '?';
    this.updateSticky();
  }

  /** n行目の上端（スクロール位置の単位）。折り返しなしなら計算で、ありなら実際の位置から */
  lineTop(n) {
    if (!this.wrap) return (n - 1) * this.lineHeight;
    const r = this.row(n);
    return r ? r.offsetTop : 0;
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

    // 行ごとのインデント幅（桁）。空行は前後の行の浅い方に合わせ、罫線が途切れないようにする
    const prefixes = raw.map((l) => /^[ \t]*/.exec(l)[0]);
    const blank = raw.map((l, i) => prefixes[i].length === l.length);
    const cols = prefixes.map(indentCols);
    const guide = cols.slice();
    let prev = 0;
    const nextNonBlank = new Array(raw.length);
    let next = 0;
    for (let i = raw.length - 1; i >= 0; i--) { if (!blank[i]) next = cols[i]; nextNonBlank[i] = next; }
    for (let i = 0; i < raw.length; i++) {
      if (blank[i]) guide[i] = Math.min(prev, nextNonBlank[i]);
      else prev = cols[i];
    }
    this.linesEl.style.setProperty('--unit', `${guessIndentUnit(cols.filter((_, i) => !blank[i]), raw)}ch`);
    this.cols = cols;
    this.blank = blank;
    this.computeScopes(nextNonBlank);
    // 折り返さない表示では画面外の行のレイアウトを省くので、全体の幅をあらかじめ決めておく
    let maxCols = 0;
    for (const l of raw) { if (l.length * 2 > maxCols) { const c = displayCols(l); if (c > maxCols) maxCols = c; } }
    this.linesEl.style.setProperty('--cols', String(maxCols));
    if (this.stickyEl) this.stickyEl.style.setProperty('--gutter-w', `${Math.max(3, digits)}ch`);

    const parts = new Array(htmlLines.length);
    for (let i = 0; i < htmlLines.length; i++) {
      const n = i + 1;
      const pre = blank[i] ? '' : prefixes[i];
      const body = blank[i] ? '' : stripLeading(htmlLines[i] || '', pre.length);
      const style = cols[i] || guide[i] ? ` style="--iw:${blank[i] ? 0 : cols[i]}ch;--gw:${guide[i]}ch"` : '';
      // .i … 行頭のインデント（折り返さない表示ではそのまま空白として表示し、折り返し表示では余白に置き換える）
      const ind = pre ? `<span class="i">${pre}</span>` : '';
      parts[i] = `<div class="ln" data-n="${n}"${style}><span class="g">${n}</span><span class="s">${ind}${body || (pre ? '' : ' ')}</span></div>`;
    }
    this.linesEl.innerHTML = parts.join('');
    this.anchor = 1;
    this.sel = null;
    this.applyBookmarks();
    this.stickyKey = '?';
    this.updateSticky();
  }

  row(n) {
    return this.linesEl.children[n - 1] || null;
  }

  topLine() {
    return this.lineAtY(this.scrollEl.scrollTop);
  }

  /** n行目が画面の上の方に来るようにスクロールする */
  scrollToLine(n, { left = null, margin = 0 } = {}) {
    const target = Math.max(0, this.lineTop(n) - margin * this.lineHeight);
    this.scrollEl.scrollTop = target;
    this.anchor = this.topLine();
    if (left !== null) this.scrollEl.scrollLeft = left;
  }

  /** n行目（〜m行目）へ移動して一瞬光らせる */
  jumpTo(n, m = n) {
    n = Math.min(Math.max(1, n), this.lineCount);
    m = Math.min(Math.max(n, m), this.lineCount);
    const viewLines = Math.floor(this.scrollEl.clientHeight / this.lineHeight);
    const st = this.scrollEl.scrollTop;
    const rowM = this.row(m);
    const bottom = this.wrap && rowM ? rowM.offsetTop + rowM.offsetHeight : this.lineTop(m) + this.lineHeight;
    const inView = this.lineTop(n) >= st + this.stickyHeight() && bottom <= st + this.scrollEl.clientHeight - this.bottomInset - this.lineHeight;
    // 上に重なるスティッキー表示の行数ぶん、余裕を持たせて止める
    const depth = this.stickyOn && this.stickyEl ? this.scopeChain(n - 1).length : 0;
    if (!inView) this.scrollToLine(n, { margin: Math.min(depth + 2, Math.max(1, Math.floor(viewLines / 3))) });
    this.updateSticky();
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

  /** ranges: [{ line, lineEnd }]。先頭行に旗、残りの行に帯を付ける */
  setBookmarks(ranges) {
    this.bookmarkRanges = ranges;
    this.applyBookmarks();
  }

  applyBookmarks() {
    for (const el of this.linesEl.querySelectorAll('.ln.bm, .ln.bmr')) el.classList.remove('bm', 'bmr');
    for (const r of this.bookmarkRanges || []) {
      this.row(r.line)?.classList.add('bm');
      for (let n = r.line + 1; n <= (r.lineEnd || r.line); n++) this.row(n)?.classList.add('bmr');
    }
    this.stickyKey = '?';
    this.updateSticky();
  }

  /** 行範囲のテキスト（行番号付き） */
  numbered(a = 1, b = this.lineCount) {
    const w = String(this.lineCount).length;
    const out = [];
    for (let i = a; i <= b; i++) out.push(`${String(i).padStart(w, ' ')}| ${this.lines[i - 1] ?? ''}`);
    return out.join('\n');
  }
}
