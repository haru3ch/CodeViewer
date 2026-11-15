// ファイル内検索と「同じ単語をすべてハイライト」。
// ハイライトは CSS Custom Highlight API を使い、コードの DOM には手を入れない
// （対応していないブラウザでは、件数表示と前後への移動だけが使える）。

const MAX_MARKS = 5000;
const canMark = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export class Finder {
  /** viewer: Viewer, ui: { bar, input, count, prev, next, close } */
  constructor(viewer, ui) {
    this.viewer = viewer;
    this.ui = ui;
    this.matches = [];   // [{ line（1始まり）, start, end }]
    this.cur = -1;
    this.query = '';
    this.word = false;   // 単語として一致（長押しで選んだとき）

    ui.input.addEventListener('input', () => this.search(ui.input.value, { word: false }));
    ui.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') this.close();
    });
    ui.prev.addEventListener('click', () => this.step(-1));
    ui.next.addEventListener('click', () => this.step(1));
    ui.close.addEventListener('click', () => this.close());

    // コード上で単語を選ぶ（スマホは長押し、PCはダブルクリック）と、同じ単語をすべてハイライト
    let t = 0;
    document.addEventListener('selectionchange', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.anchorNode || !viewer.linesEl.contains(sel.anchorNode)) return;
        const text = String(sel);
        if (!/^[\p{L}\p{N}_$]{2,80}$/u.test(text) || (text === this.query && this.word)) return;
        this.open({ focus: false });
        ui.input.value = text;
        this.search(text, { word: true, jump: false });
      }, 350);
    });
  }

  get isOpen() { return !this.ui.bar.classList.contains('hidden'); }

  open({ focus = true } = {}) {
    this.ui.bar.classList.remove('hidden');
    if (this.onOpen) this.onOpen();
    if (focus) { this.ui.input.focus(); this.ui.input.select(); }
  }

  close() {
    this.ui.bar.classList.add('hidden');
    this.ui.input.blur();
    this.clear();
    if (this.onClose) this.onClose();
  }

  clear() {
    this.matches = [];
    this.cur = -1;
    this.query = '';
    this.ui.count.textContent = '';
    if (canMark) { CSS.highlights.delete('cr-find'); CSS.highlights.delete('cr-find-cur'); }
  }

  /** ファイルを開き直したとき：同じ語で検索し直す */
  refresh() {
    if (this.isOpen && this.query) this.search(this.query, { word: this.word, jump: false });
    else this.clear();
  }

  search(query, { word = false, jump = true } = {}) {
    this.clear();
    this.query = query;
    this.word = word;
    if (!query) return;
    // 小文字だけの検索は大文字小文字を区別しない。単語選択のときは完全一致
    const flags = word || /[A-Z]/.test(query) ? 'gu' : 'giu';
    const body = escapeRe(query);
    const re = new RegExp(word ? `(?<![\\p{L}\\p{N}_$])${body}(?![\\p{L}\\p{N}_$])` : body, flags);
    const lines = this.viewer.lines;
    for (let i = 0; i < lines.length && this.matches.length < MAX_MARKS; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) && this.matches.length < MAX_MARKS) {
        this.matches.push({ line: i + 1, start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
    }
    this.mark();
    if (!this.matches.length) { this.ui.count.textContent = '0件'; return; }
    // 今見ている位置から一番近い（以降の）一致を現在位置にする
    const top = this.viewer.lineAtY(this.viewer.scrollEl.scrollTop + this.viewer.stickyHeight());
    let idx = this.matches.findIndex((x) => x.line >= top);
    if (idx < 0) idx = 0;
    this.setCurrent(idx, jump);
  }

  rangeFor(match) {
    const row = this.viewer.row(match.line);
    const s = row && row.querySelector('.s');
    if (!s) return null;
    const walker = document.createTreeWalker(s, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let pos = 0;
    let started = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const len = node.nodeValue.length;
      if (!started && match.start < pos + len) { range.setStart(node, match.start - pos); started = true; }
      if (started && match.end <= pos + len) { range.setEnd(node, match.end - pos); return range; }
      pos += len;
    }
    return null;
  }

  mark() {
    if (!canMark) return;
    const ranges = [];
    for (const m of this.matches) { const r = this.rangeFor(m); if (r) ranges.push(r); }
    if (ranges.length) CSS.highlights.set('cr-find', new Highlight(...ranges));
  }

  setCurrent(idx, jump = true) {
    this.cur = idx;
    const m = this.matches[idx];
    const more = this.matches.length >= MAX_MARKS ? '+' : '';
    this.ui.count.textContent = `${idx + 1}/${this.matches.length}${more}`;
    if (canMark) {
      const r = this.rangeFor(m);
      if (r) CSS.highlights.set('cr-find-cur', new Highlight(r));
    }
    if (jump) {
      this.viewer.jumpTo(m.line);
      // 折り返さない表示で一致が右の方にあるときは、横にも送る
      if (!this.viewer.wrap) {
        const r = this.rangeFor(m);
        const box = r && r.getBoundingClientRect();
        const view = this.viewer.scrollEl.getBoundingClientRect();
        if (box && box.width && (box.right > view.right - 20 || box.left < view.left + 60)) {
          this.viewer.scrollEl.scrollLeft += box.left - view.left - view.width / 3;
        }
      }
    }
  }

  step(d) {
    if (!this.matches.length) return;
    this.setCurrent((this.cur + d + this.matches.length) % this.matches.length);
  }
}
