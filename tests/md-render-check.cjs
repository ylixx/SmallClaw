/**
 * Temporary verification for the UI markdown renderer added to web-ui/index.html.
 * Extracts the REAL function bodies from the html file and runs assertions,
 * covering structure rendering, XSS safety and streaming-incomplete input.
 */
const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, '..', 'web-ui', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf-8');

function extractFn(src, name, untilNames) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  const ends = untilNames.map(n => src.indexOf('function ' + n + '(', start + 10)).filter(i => i > start);
  const end = Math.min(...ends);
  return src.slice(start, end);
}

const fns = [
  extractFn(html, 'escHtml', ['timeAgo']),
  extractFn(html, 'mdInline', ['splitTableRow']),
  extractFn(html, 'splitTableRow', ['renderMarkdown']),
  extractFn(html, 'renderMarkdown', ['renderAssistantContent']),
  extractFn(html, 'renderAssistantContent', ['renderArtifacts']),
];
let src = fns.join('\n');
src += `
module.exports = { escHtml, mdInline, splitTableRow, renderMarkdown, renderAssistantContent };
`;
const modPath = path.join(__dirname, 'md-render-extracted.cjs');
fs.writeFileSync(modPath, src, 'utf-8');
const { renderMarkdown, renderAssistantContent } = require(modPath);

let pass = 0, fail = 0;
function has(name, actual, needle) {
  const ok = actual.includes(needle);
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n    needle: ' + JSON.stringify(needle) + '\n    actual: ' + JSON.stringify(actual)); }
}
function notHas(name, actual, needle) {
  const ok = !actual.includes(needle);
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' (should NOT contain ' + JSON.stringify(needle) + ')\n    actual: ' + JSON.stringify(actual)); }
}
function eq(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n    expected: ' + JSON.stringify(expected) + '\n    actual:   ' + JSON.stringify(actual)); }
}

console.log('--- headings ---');
has('h1', renderMarkdown('# 季度总结'), '<h1 class="md-h">季度总结</h1>');
has('h3', renderMarkdown('### 结果'), '<h3 class="md-h">结果</h3>');
has('h2 inline strong', renderMarkdown('## 收入 **增长**'), '<h2 class="md-h">收入 <strong>增长</strong></h2>');

console.log('--- tables ---');
const mdTable = '| 指标 | 数值 |\n| --- | --- |\n| 收入 | 120 |\n| 利润 | 35 |';
const t = renderMarkdown(mdTable);
has('table open', t, '<table class="md-table">');
has('thead', t, '<thead><tr><th>指标</th><th>数值</th></tr></thead>');
has('row1', t, '<td>收入</td><td>120</td>');
has('row2', t, '<td>利润</td><td>35</td>');

console.log('--- lists ---');
eq('ul 2 items', renderMarkdown('- 收入增长 12%\n- 成本下降 4%'), '<ul class="md-list"><li>收入增长 12%</li><li>成本下降 4%</li></ul>');
eq('ol 2 items', renderMarkdown('1. one\n2. two'), '<ol class="md-list"><li>one</li><li>two</li></ol>');

console.log('--- code ---');
const code = renderMarkdown('```js\nconst a = 1 < 2;\n```');
has('pre open', code, '<pre class="md-code">');
has('code escaped', code, 'const a = 1 &lt; 2;');
has('inline code', renderMarkdown('use `npm test` now'), '<p>use <code>npm test</code> now</p>');

console.log('--- links ---');
has('safe link', renderMarkdown('[visit](https://example.com)'), '<a href="https://example.com" target="_blank" rel="noopener noreferrer">visit</a>');
const evil = renderMarkdown('[x](javascript:alert(1))');
has('js link blocked', evil, 'x (javascript:alert(1))');
notHas('js link no href', evil, 'href="javascript:');

console.log('--- XSS safety ---');
const xss = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>');
notHas('no script tag', xss, '<script>');
has('script escaped', xss, '&lt;script&gt;');
notHas('no img tag', xss, '<img');
has('img escaped', xss, '&lt;img');

console.log('--- streaming-incomplete input ---');
eq('empty', renderMarkdown(''), '');
eq('table w/o sep row = paragraphs', renderMarkdown('| a | b |\n| 1 | 2 |'), '<p>| a | b | | 1 | 2 |</p>');
const openFence = renderMarkdown('```json\n{"a": 1}\n');
eq('unclosed fence no crash', typeof openFence, 'string');
has('unclosed fence shows text', openFence, '{&quot;a&quot;: 1}');
const halfTable = renderMarkdown('| 指标 | 数值 |\n| --- | --- |\n| 收入 | 12');
has('half table renders row', halfTable, '<td>收入</td><td>12</td>');

console.log('--- staged messages ---');
const staged = renderAssistantContent('Initial chat: hi\n---\nExecution result: done\n---\nFinal chat: # 总结\n\n| a | b |\n| - | - |\n| 1 | 2 |');
has('staged title kept', staged, 'msg-stage-title">Initial chat</div>');
has('staged final md rendered', staged, '<h1 class="md-h">总结</h1>');
has('staged table rendered', staged, '<table class="md-table">');
has('plain text escaped', renderAssistantContent('<b>hi</b>'), '&lt;b&gt;hi&lt;/b&gt;');
notHas('plain text no raw tag', renderAssistantContent('<b>hi</b>'), '<b>hi</b>');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
