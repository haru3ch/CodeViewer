// 目次：ファイル内の関数・クラス（Markdown は見出し）を一覧にする。
// 厳密な構文解析ではなく、行の書き方（正規表現）とインデントの深さで拾う簡易版。

const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'function', 'new', 'throw', 'case', 'delete', 'typeof', 'await', 'with', 'using', 'typedef', 'sizeof', 'elif', 'except', 'lock', 'foreach', 'fixed']);

const JS_RULES = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/, null],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'const'],
  [/^\s+(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, 'method'],
];

const C_TYPE = /^\s*(?:template\s*<[^>]*>\s*)?(?:(?:public|private|protected|internal|static|sealed|abstract|partial|export)\s+)*(class|struct|namespace|enum(?:\s+class)?|cbuffer|interface|union)\s+([A-Za-z_]\w*)/;
const C_FUNC = /^\s*[A-Za-z_][\w:<>,*&\s[\]~]*?[\s*&]([A-Za-z_~][\w:~]*)\s*\(/;

function cLike(lines, i) {
  const l = lines[i];
  let m = C_TYPE.exec(l);
  // 「class Foo;」のような前方宣言は除く（1行で { } まで書いてあるものは載せる）
  if (m && (l.includes('{') || !/;\s*$/.test(l))) return { kind: m[1].replace(/\s+/g, ' '), name: m[2] };
  m = C_FUNC.exec(l);
  if (!m || /;\s*$/.test(l)) return null;
  const first = /^\s*([A-Za-z_]\w*)/.exec(l);
  if (first && KW.has(first[1])) return null;
  if (KW.has(m[1])) return null;
  const head = l.slice(0, l.indexOf('('));
  if (head.includes('=')) return null;
  // 本体（{）がこの行か、数行以内に続くものだけ（宣言や呼び出しを除く）
  for (let k = i; k < Math.min(lines.length, i + 6); k++) {
    const t = lines[k];
    if (t.includes('{')) return { kind: 'function', name: m[1] };
    if (k > i && /;\s*$/.test(t)) return null;
  }
  return null;
}

function match(lang, lines, i) {
  const l = lines[i];
  let m;
  switch (lang) {
    case 'python':
      m = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(l);
      return m ? { kind: m[1], name: m[2] } : null;
    case 'javascript':
    case 'typescript':
      for (const [re, kind] of JS_RULES) {
        m = re.exec(l);
        if (!m) continue;
        const name = kind ? m[1] : m[2];
        if (KW.has(name)) return null;
        return { kind: kind || m[1], name };
      }
      return null;
    case 'c': case 'cpp': case 'csharp': case 'hlsl': case 'glsl':
      return cLike(lines, i);
    case 'lua':
      m = /^\s*(?:local\s+)?function\s+([\w.:]+)/.exec(l);
      return m ? { kind: 'function', name: m[1] } : null;
    case 'bash':
      m = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?\s*$/.exec(l) || /^\s*function\s+([A-Za-z_][\w-]*)/.exec(l);
      return m ? { kind: 'function', name: m[1] } : null;
    default:
      return null;
  }
}

export function supportsOutline(lang) {
  return ['python', 'javascript', 'typescript', 'c', 'cpp', 'csharp', 'hlsl', 'glsl', 'lua', 'bash', 'markdown'].includes(lang);
}

/**
 * lines: ファイルの各行, cols: 各行のインデント幅（桁）
 * 戻り値: [{ line（1始まり）, kind, name, depth }]
 */
export function buildOutline(lines, lang, cols) {
  const items = [];
  if (lang === 'markdown') {
    let fence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
      if (fence) continue;
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
      if (m) items.push({ line: i + 1, kind: '#'.repeat(m[1].length), name: m[2], depth: m[1].length - 1 });
    }
    return items;
  }
  // 入れ子の深さは、目次に載った項目どうしのインデントの大小で決める
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 400) continue;
    const hit = match(lang, lines, i);
    if (!hit) continue;
    while (stack.length && stack[stack.length - 1] >= cols[i]) stack.pop();
    items.push({ line: i + 1, kind: hit.kind, name: hit.name, depth: stack.length });
    stack.push(cols[i]);
  }
  return items;
}
