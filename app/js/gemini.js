// Gemini（Google AI Studio の API キー）への問い合わせ。無料枠で使える。
// Claude と同じく、この端末のブラウザから Google の API へ直接送る（間に自前のサーバーは挟まない）。
// Google は公式の JS SDK も出しているが、使うのは「送る・少しずつ受け取る」だけなので fetch で直接呼ぶ。

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';

/**
 * このキーで使えるモデルの一覧を取る（モデル名は頻繁に変わるので、アプリに固定で持たない）。
 * 戻り値: [{ id, label }]（文章生成に使えるものだけ。Flash 系を先頭に）
 */
export async function listGeminiModels(apiKey) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const res = await fetch(`${BASE}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) throw new Error(await errorText(res));
    const data = await res.json();
    for (const m of data.models || []) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (!id.startsWith('gemini') || /embedding|tts|image|audio|live|robotics|computer-use/i.test(id)) continue;
      out.push({ id, label: m.displayName ? `${m.displayName}（${id}）` : id });
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  const rank = (id) => (id.includes('flash-lite') ? 1 : id.includes('flash') ? 0 : 2);
  out.sort((a, b) => rank(a.id) - rank(b.id) || b.id.localeCompare(a.id));
  return out;
}

async function errorText(res) {
  let msg = '';
  try { msg = (await res.json()).error?.message || ''; } catch { /* JSON でない */ }
  if (res.status === 429) return `Gemini の利用上限（無料枠の回数制限）に達しました。1分ほど待つか、⚙ 設定で別のモデル（Flash-Lite など）を選んでください。${msg ? `\n（${msg}）` : ''}`;
  if (res.status === 400 && /API key/i.test(msg)) return 'Gemini の APIキーが正しくないようです。⚙ 設定で確認してください。';
  if (res.status === 401 || res.status === 403) return `この APIキーでは Gemini を使えないようです。⚙ 設定で確認してください。${msg ? `\n（${msg}）` : ''}`;
  if (res.status === 404) return 'このモデルは見つかりませんでした。⚙ 設定の「モデル一覧を更新」を押して、別のモデルを選んでください。';
  if (res.status >= 500) return 'Gemini 側が混み合っています。少し待ってからもう一度試してください。';
  return `エラー (${res.status}): ${msg || res.statusText}`;
}

/** Claude 形式の会話履歴（content が文字列またはブロックの配列）を Gemini の形式にする */
function toContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{
      text: typeof m.content === 'string'
        ? m.content
        : m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    }],
  }));
}

/**
 * 戻り値は ai.js の ask() と同じ形: { ok, content, text, stopReason, model, note } / { ok:false, error, aborted }
 */
export async function askGemini({ apiKey, model, system, messages, onText, signal }) {
  const id = model || GEMINI_DEFAULT_MODEL;
  const started = performance.now();
  console.info(`Geminiに送信: ${id} 会話${messages.length}件 文脈${system.length}文字`);
  try {
    const res = await fetch(`${BASE}/models/${encodeURIComponent(id)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: toContents(messages),
      }),
    });
    if (!res.ok) {
      const error = await errorText(res);
      console.error(`Geminiエラー: HTTP ${res.status}`, error);
      return { ok: false, error };
    }

    // 少しずつ届く返答（SSE）を読む。1つの「data: {...}」が返答の断片
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let finish = '';
    let blocked = '';
    let usage = null;
    const handle = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { return; }
      if (chunk.error) throw new Error(chunk.error.message || 'Gemini エラー');
      if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const cand = chunk.candidates?.[0];
      if (!cand) return;
      if (cand.finishReason) finish = cand.finishReason;
      for (const part of cand.content?.parts || []) {
        if (part.thought || typeof part.text !== 'string' || !part.text) continue; // 思考の要約は表示しない
        text += part.text;
        onText(part.text);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) handle(buf);

    console.info(`Gemini応答: ${id} ${((performance.now() - started) / 1000).toFixed(1)}秒 finish=${finish || '?'} 入力${usage?.promptTokenCount ?? '?'} 出力${usage?.candidatesTokenCount ?? '?'}トークン`);
    let note = '';
    if (blocked) note = `Gemini がこの依頼を受け付けませんでした（${blocked}）。`;
    else if (finish === 'MAX_TOKENS') note = '回答が長すぎて途中で切れました。「続けて」と送ると続きを書きます。';
    else if (finish && finish !== 'STOP') note = `Gemini が回答を途中で止めました（${finish}）。`;
    if (!text && !note) note = 'Gemini から空の回答が返りました。もう一度試してください。';
    if (!text) return { ok: false, error: note };
    return { ok: true, content: text, text, stopReason: finish, model: id, note };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, error: '停止しました。', aborted: true };
    console.error('Geminiエラー:', err);
    const offline = err instanceof TypeError;
    return { ok: false, error: offline ? 'ネットワークにつながりませんでした。通信状態を確認してください。' : `エラー: ${err.message || err}` };
  }
}
