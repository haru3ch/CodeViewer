// AIチャット欄。1つの会話 = 1つのファイル + 最初に選んだ行範囲。
// 質問しても選択範囲とコード表示は消えない。会話は端末内に保存し、ファイルを開き直すと戻る。

import { marked, DOMPurify } from '../vendor/vendor.js';
import * as ai from './ai.js';
import * as db from './db.js';

marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(text) {
  const html = DOMPurify.sanitize(marked.parse(text || ''), { USE_PROFILES: { html: true } });
  const div = document.createElement('div');
  div.innerHTML = html;
  for (const a of div.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  linkifyLineRefs(div);
  return div;
}

// 「L12」「L12-L20」「L12〜20」を、タップでその行へ飛べるボタンにする
const LINE_RE = /L(\d{1,6})(?:\s*[-–—〜~]\s*L?(\d{1,6}))?/g;
function linkifyLineRefs(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement && node.parentElement.closest('pre')) continue; // コードブロック内はそのまま
    LINE_RE.lastIndex = 0;
    if (LINE_RE.test(node.nodeValue)) targets.push(node);
  }
  for (const node of targets) {
    const frag = document.createDocumentFragment();
    const s = node.nodeValue;
    let last = 0;
    LINE_RE.lastIndex = 0;
    let m;
    while ((m = LINE_RE.exec(s))) {
      // 直前が英数字なら（例: "HTML5" の一部など）行番号ではない
      if (m.index > 0 && /[A-Za-z0-9_]/.test(s[m.index - 1])) continue;
      frag.append(s.slice(last, m.index));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lineref';
      btn.textContent = m[0];
      btn.dataset.a = m[1];
      btn.dataset.b = m[2] || m[1];
      frag.append(btn);
      last = m.index + m[0].length;
    }
    frag.append(s.slice(last));
    node.replaceWith(frag);
  }
}

export class Chat {
  /**
   * deps: {
   *   logEl, formEl, inputEl, sendBtn, stopBtn, contextEl,
   *   getSettings(): {apiKey, model, effort},
   *   getFileContext(): { repoId, repoName, path, ... } | null   … 今開いているファイルの情報
   *   onLineRef(path, a, b)  … 回答内の行番号がタップされた
   *   needApiKey()           … APIキー未設定のとき
   *   toast(msg)
   * }
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.conv = null;   // { repoId, path, range, context, api: MessageParam[], view: [{role, text, range?, note?, model?}] }
    this.abort = null;

    this.formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = this.inputEl.value.trim();
      if (!q) return;
      this.askQuestion(q);
    });
    this.inputEl.addEventListener('keydown', (e) => {
      // 外付けキーボード: ⌘/Ctrl + Enter で送信
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.formEl.requestSubmit(); }
    });
    this.stopBtn.addEventListener('click', () => this.abort && this.abort.abort());
    this.logEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.lineref');
      if (!btn || !this.conv) return;
      this.onLineRef(this.conv.path, Number(btn.dataset.a), Number(btn.dataset.b));
    });
  }

  get busy() { return !!this.abort; }

  key(repoId, path) { return `chat:${repoId}:${path}`; }

  /** ファイルを開いたとき、そのファイルの前回の会話を戻す */
  async loadFor(repoId, path) {
    if (this.busy) return; // 回答中は会話を差し替えない
    const saved = await db.kvGet(this.key(repoId, path));
    this.conv = saved || null;
    this.render();
  }

  async save() {
    if (!this.conv) return;
    await db.kvSet(this.key(this.conv.repoId, this.conv.path), this.conv);
  }

  async reset() {
    if (this.busy) return;
    if (this.conv) await db.kvDelete(this.key(this.conv.repoId, this.conv.path));
    this.conv = null;
    this.render();
  }

  render() {
    const c = this.conv;
    this.contextEl.textContent = c
      ? `${c.path}${c.range ? ` L${c.range.a}${c.range.b !== c.range.a ? `-L${c.range.b}` : ''}` : '（ファイル全体）'}`
      : '';
    this.logEl.innerHTML = '';
    if (!c || c.view.length === 0) {
      const p = document.createElement('p');
      p.className = 'chat-empty';
      p.innerHTML = '行をタップして範囲を選び「解説して」を押してください。<br>選択なしで質問すると、ファイル全体についての質問になります。';
      this.logEl.append(p);
      return;
    }
    for (const m of c.view) this.logEl.append(this.msgEl(m));
    this.scrollToBottom();
  }

  msgEl(m) {
    const el = document.createElement('div');
    el.className = `msg ${m.role}`;
    if (m.role === 'user') {
      if (m.label) {
        const r = document.createElement('span');
        r.className = 'msg-range';
        r.textContent = m.label;
        el.append(r);
      }
      el.append(document.createTextNode(m.text));
    } else if (m.role === 'assistant') {
      el.append(renderMarkdown(m.text));
      if (m.note || m.model) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = [m.note, m.model].filter(Boolean).join(' ・ ');
        el.append(meta);
      }
    } else {
      el.textContent = m.text;
    }
    return el;
  }

  scrollToBottom() {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** 「解説して」：新しい会話を始める */
  async explain(range) {
    const fc = this.getFileContext();
    if (!fc || this.busy) return;
    const { apiKey } = this.getSettings();
    if (!apiKey) { this.needApiKey(); return; }
    const where = range.a === range.b ? `L${range.a}` : `L${range.a}-L${range.b}`;
    this.conv = {
      repoId: fc.repoId, path: fc.path, range,
      context: fc.buildContext(),
      api: [],
      view: [],
    };
    const userText = ai.buildExplainMessage({ path: fc.path, a: range.a, b: range.b, numberedRange: fc.numbered(range.a, range.b) });
    await this.send(userText, { role: 'user', isExplain: true, label: `${where} を解説して`, text: firstLine(fc.lineText(range.a)) + (range.b > range.a ? ' …' : '') });
  }

  /** チャット欄からの質問 */
  async askQuestion(question) {
    const fc = this.getFileContext();
    if (this.busy) return;
    const { apiKey } = this.getSettings();
    if (!apiKey) { this.needApiKey(); return; }

    // 会話がない／別ファイルの会話のときは、今のファイル・今の選択で新しく始める
    if (!this.conv || this.conv.api.length === 0 || !fc || this.conv.path !== fc.path || this.conv.repoId !== fc.repoId) {
      if (!fc) { this.toast('先にファイルを開いてください'); return; }
      const range = fc.range();
      this.conv = { repoId: fc.repoId, path: fc.path, range, context: fc.buildContext(), api: [], view: [] };
      let text;
      if (range) {
        text = ai.buildExplainMessage({ path: fc.path, a: range.a, b: range.b, numberedRange: fc.numbered(range.a, range.b) })
          .replace('この範囲を解説してください。', `この範囲について質問です。\n${question}`);
      } else {
        text = ai.buildQuestionMessage({ question, path: fc.path, range: null });
      }
      this.inputEl.value = '';
      await this.send(text, { role: 'user', text: question, label: range ? labelOf(range) : 'ファイル全体' });
      return;
    }
    this.inputEl.value = '';
    // 同じ会話の続き。今の選択が最初の範囲と違えば、それも添える
    const cur = fc.range();
    let text = question;
    let label = '';
    if (cur && (!this.conv.range || cur.a !== this.conv.range.a || cur.b !== this.conv.range.b)) {
      text = `（いま選択している範囲: L${cur.a}${cur.b !== cur.a ? `-L${cur.b}` : ''}）\n<selection>\n${fc.numbered(cur.a, cur.b)}\n</selection>\n${question}`;
      label = labelOf(cur);
    }
    await this.send(text, { role: 'user', text: question, label });
  }

  async send(apiText, viewMsg) {
    const c = this.conv;
    c.api.push({ role: 'user', content: apiText });
    c.view.push(viewMsg);
    this.render();

    const out = { role: 'assistant', text: '' };
    const el = this.msgEl(out);
    el.classList.add('streaming');
    this.logEl.append(el);
    this.scrollToBottom();

    this.abort = new AbortController();
    this.setBusy(true);
    let pending = false;
    const repaint = () => {
      pending = false;
      const nearBottom = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 80;
      el.replaceChildren(renderMarkdown(out.text));
      if (nearBottom) this.scrollToBottom();
    };
    const { apiKey, model, effort } = this.getSettings();
    const res = await ai.ask({
      apiKey, model, effort,
      context: c.context,
      messages: c.api,
      signal: this.abort.signal,
      onText: (d) => {
        out.text += d;
        if (!pending) { pending = true; requestAnimationFrame(repaint); }
      },
    });
    this.abort = null;
    this.setBusy(false);

    if (this.conv !== c) return; // 回答中に会話が切り替わった
    if (res.ok) {
      c.api.push({ role: 'assistant', content: res.content });
      c.view.push({ role: 'assistant', text: res.text || out.text, note: res.note, model: res.model });
    } else {
      // 失敗した質問は履歴から外す（次に送り直せるように）
      c.api.pop();
      if (out.text) c.view.push({ role: 'assistant', text: out.text, note: '（途中まで）' });
      c.view.push({ role: 'error', text: res.error });
      // 質問文だった場合は入力欄に戻して、そのまま送り直せるようにする
      if (!res.aborted && !viewMsg.isExplain) this.inputEl.value = viewMsg.text || '';
    }
    this.render();
    await this.save();
  }

  setBusy(b) {
    this.sendBtn.classList.toggle('hidden', b);
    this.stopBtn.classList.toggle('hidden', !b);
  }
}

function labelOf(r) {
  return r.a === r.b ? `L${r.a}` : `L${r.a}-L${r.b}`;
}

function firstLine(s) {
  s = (s || '').trim();
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}
