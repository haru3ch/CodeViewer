// app/vendor/vendor.js の元。npm のライブラリを1つの ES モジュールにまとめる。
export { default as Anthropic } from '@anthropic-ai/sdk';
export { marked } from 'marked';
export { default as DOMPurify } from 'dompurify';

import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import csharp from 'highlight.js/lib/languages/csharp';
import markdown from 'highlight.js/lib/languages/markdown';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import ini from 'highlight.js/lib/languages/ini';
import glsl from 'highlight.js/lib/languages/glsl';
import lua from 'highlight.js/lib/languages/lua';
import plaintext from 'highlight.js/lib/languages/plaintext';

const langs = { python, javascript, typescript, cpp, c, csharp, markdown, json, yaml, xml, css, bash, powershell, ini, glsl, lua, plaintext };
for (const [name, def] of Object.entries(langs)) hljs.registerLanguage(name, def);

// HLSL は highlight.js に無いので、C++ の定義に HLSL の型・キーワードを足して作る。
const HLSL_TYPES = [];
for (const base of ['float', 'half', 'int', 'uint', 'bool', 'double', 'min16float', 'min16int', 'min16uint']) {
  HLSL_TYPES.push(base);
  for (let n = 1; n <= 4; n++) {
    HLSL_TYPES.push(base + n);
    for (let m = 1; m <= 4; m++) HLSL_TYPES.push(`${base}${n}x${m}`);
  }
}
HLSL_TYPES.push('Texture1D', 'Texture2D', 'Texture3D', 'TextureCube', 'Texture2DArray', 'TextureCubeArray',
  'RWTexture2D', 'RWTexture3D', 'Buffer', 'RWBuffer', 'StructuredBuffer', 'RWStructuredBuffer',
  'ByteAddressBuffer', 'RWByteAddressBuffer', 'AppendStructuredBuffer', 'ConsumeStructuredBuffer',
  'SamplerState', 'SamplerComparisonState', 'sampler', 'matrix', 'vector', 'FMaterialPixelParameters',
  'FMaterialVertexParameters', 'FPixelMaterialInputs');
const HLSL_KEYWORDS = ['cbuffer', 'tbuffer', 'groupshared', 'uniform', 'in', 'out', 'inout', 'nointerpolation',
  'linear', 'centroid', 'noperspective', 'precise', 'row_major', 'column_major', 'discard', 'technique', 'pass',
  'numthreads', 'unroll', 'loop', 'branch', 'flatten', 'register', 'packoffset'];
hljs.registerLanguage('hlsl', (h) => {
  const def = cpp(h);
  const kw = { ...def.keywords };
  const add = (field, words) => {
    const cur = kw[field];
    if (Array.isArray(cur)) kw[field] = [...cur, ...words];
    else if (typeof cur === 'string') kw[field] = cur + ' ' + words.join(' ');
    else kw[field] = words;
  };
  add('type', HLSL_TYPES);
  add('keyword', HLSL_KEYWORDS);
  return { ...def, name: 'HLSL', aliases: ['usf', 'ush', 'fx', 'hlsli'], keywords: kw };
});

export { hljs };
