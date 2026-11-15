// AI（Claude）への問い合わせ。
// APIキーは端末内（localStorage）にだけ置き、この端末のブラウザから Anthropic の API へ直接送る。
// 間に自前のサーバーは挟まない（＝コードもキーもどこにも保存されない）。

import { Anthropic } from '../vendor/vendor.js';
import { askGemini } from './gemini.js';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（標準・おすすめ）', fallback: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（速い・安い）', fallback: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（最速・最安）', fallback: false },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2（最上位・高価）', fallback: true },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';

// 仕様書 §4 の固定プロンプト ＋ アプリで使うための追加ルール
const FIXED_PROMPT = `あなたはコードの読解を手伝うアシスタントです。日本語で答えてください。
対象ファイル全体と、ユーザーが選んだ行範囲、リポジトリ要約（READING.md）を踏まえて説明してください。
- まず「この範囲が何をしているか」を1〜2文で。
- 次に処理の流れを行番号を引用しながら説明してください。
- 「なぜこういう設計にしたか」が分かる場合は、その意図も述べてください。
- 推測で断定せず、分からない部分は分からないと書いてください。

追加のルール:
- 回答は必ず日本語で書く。
- 行番号は必ず「L12」や「L12-L20」の形で書く（アプリ上でタップするとその行へ移動できる）。行番号は、渡したファイル内容の各行の先頭にある番号に従う。
- 専門用語は、初めて出てきたときに（）で一言だけ補足する。
- 読み手はタブレットで読んでいる。コードの長い再掲は避け、必要なら数行の抜粋にとどめる。見出しや箇条書きで短く区切る。
- フォローアップの質問には、最初に選ばれた行範囲の文脈を保ったまま答える。`;

/**
 * 「アプリで聞く」用：Claude / ChatGPT のアプリに貼り付ける1つの質問文を作る。
 * API版と同じ指示・同じ文脈を、1回分のメッセージにまとめたもの。
 */
export function buildCopyPrompt({ context, path, a, b, numberedRange }) {
  return `${FIXED_PROMPT}

以下が、対象のリポジトリとファイルです。

${context}

---

${buildExplainMessage({ path, a, b, numberedRange })}`;
}

/**
 * リポジトリとファイルの文脈（system の2ブロック目）。
 * 同じファイルで質問を続ける間は同じ内容なので、プロンプトキャッシュが効いて2回目以降が安く速くなる。
 */
export function buildContext({ repoName, filePaths, summaryName, summaryText, path, numberedText, lineCount }) {
  const MAX_LIST = 400;
  const list = filePaths.length > MAX_LIST
    ? filePaths.slice(0, MAX_LIST).join('\n') + `\n…ほか ${filePaths.length - MAX_LIST} ファイル`
    : filePaths.join('\n');
  const summary = summaryText
    ? `## リポジトリ要約（${summaryName}）\n<summary>\n${summaryText}\n</summary>`
    : '## リポジトリ要約\n（READING.md も README も見つかりませんでした）';
  return `# リポジトリ: ${repoName}

## ファイル一覧
<file_list>
${list}
</file_list>

${summary}

## 対象ファイル: ${path}（全 ${lineCount} 行。各行の先頭が行番号）
<file path="${path}">
${numberedText}
</file>`;
}

/** 最初の「解説して」のユーザーメッセージ */
export function buildExplainMessage({ path, a, b, numberedRange }) {
  const where = a === b ? `L${a}` : `L${a}-L${b}`;
  return `${path} の ${where} を選びました。この範囲を解説してください。

<selection lines="${where}">
${numberedRange}
</selection>`;
}

/** 選択範囲を伴うフォローアップ質問 */
export function buildQuestionMessage({ question, path, range }) {
  if (!range) return `（${path} 全体について）\n${question}`;
  const where = range.a === range.b ? `L${range.a}` : `L${range.a}-L${range.b}`;
  return `（選択中の範囲: ${path} ${where}）\n${question}`;
}

function errorMessage(err) {
  if (err instanceof Anthropic.APIUserAbortError) return '停止しました。';
  if (err instanceof Anthropic.AuthenticationError) return 'APIキーが正しくないようです。設定で確認してください。';
  if (err instanceof Anthropic.PermissionDeniedError) return 'このAPIキーではこのモデルを使えないようです。設定で別のモデルを選んでください。';
  if (err instanceof Anthropic.NotFoundError) return 'モデルが見つかりませんでした。設定で別のモデルを選んでください。';
  if (err instanceof Anthropic.RateLimitError) return '利用上限（レート制限）に達しました。少し待ってからもう一度試してください。';
  if (err instanceof Anthropic.BadRequestError) return `リクエストが受け付けられませんでした: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'ネットワークにつながりませんでした。通信状態を確認してください。';
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529 || err.status >= 500) return 'AI側が混み合っています。少し待ってからもう一度試してください。';
    return `エラー (${err.status}): ${err.message}`;
  }
  return `エラー: ${err && err.message ? err.message : String(err)}`;
}

/**
 * Claude に送って、返答をストリーミングで受け取る。
 * messages: Anthropic.MessageParam[]（会話の全履歴）
 * onText(delta): 返答の文字が届くたびに呼ばれる
 * 戻り値: { ok, content, text, stopReason, model, error }
 *   content は返ってきたブロックそのまま（次の質問のときに履歴として送り返す）
 */
export async function ask({ provider, apiKey, model, effort, context, messages, onText, signal }) {
  if (provider === 'gemini') {
    return askGemini({ apiKey, model, system: `${FIXED_PROMPT}\n\n${context}`, messages, onText, signal });
  }
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const modelInfo = MODELS.find((m) => m.id === model) || MODELS[0];

  const params = {
    model: modelInfo.id,
    max_tokens: 32000,
    system: [
      { type: 'text', text: FIXED_PROMPT },
      { type: 'text', text: context, cache_control: { type: 'ephemeral' } },
    ],
    messages,
    output_config: { effort: effort || 'medium' },
  };
  // 安全判定で断られたとき、サーバー側で別モデルに自動で引き継ぐ（Haiku は非対応）
  if (modelInfo.fallback) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  const run = async (p) => {
    const stream = client.beta.messages.stream(p, { signal });
    stream.on('text', (delta) => onText(delta));
    return stream.finalMessage();
  };

  const started = performance.now();
  console.info(`AIに送信: ${modelInfo.id} effort=${params.output_config.effort} 会話${messages.length}件 文脈${context.length}文字`);
  try {
    let msg;
    try {
      msg = await run(params);
    } catch (err) {
      // 自動引き継ぎ（fallbacks）がこのアカウントで使えない場合は外して1回だけやり直す
      if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message) && params.fallbacks) {
        const rest = { ...params };
        delete rest.betas;
        delete rest.fallbacks;
        msg = await run(rest);
      } else {
        throw err;
      }
    }
    const u = msg.usage || {};
    console.info(`AI応答: ${msg.model} ${((performance.now() - started) / 1000).toFixed(1)}秒 stop=${msg.stop_reason} 入力${u.input_tokens ?? '?'} キャッシュ読込${u.cache_read_input_tokens ?? 0} キャッシュ作成${u.cache_creation_input_tokens ?? 0} 出力${u.output_tokens ?? '?'}トークン`);
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let note = '';
    if (msg.stop_reason === 'refusal') note = 'AIがこの依頼への回答を断りました。';
    else if (msg.stop_reason === 'max_tokens') note = '回答が長すぎて途中で切れました。「続けて」と送ると続きを書きます。';
    return { ok: true, content: msg.content, text, stopReason: msg.stop_reason, model: msg.model, note, usage: msg.usage };
  } catch (err) {
    console.error('AIエラー:', err && err.status ? `HTTP ${err.status}` : '', err);
    return { ok: false, error: errorMessage(err), aborted: err instanceof Anthropic.APIUserAbortError };
  }
}
