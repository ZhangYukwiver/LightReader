import fs from 'node:fs';
import vm from 'node:vm';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';

// Execute the actual functions from a pinned reader.html, without reimplementing them.
const html = fs.readFileSync(process.argv[2], 'utf8');
function block(start, end) {
  const i = html.indexOf(start);
  const j = html.indexOf(end, i + start.length);
  if (i < 0 || j < 0) throw new Error(`Missing reader function boundary: ${start}`);
  return html.slice(i, j);
}
const hasPlainText = html.includes('    function aiPlainText(value) {');
const promptCode = block('    function buildAiPrompt(raw) {',
  hasPlainText ? '    function aiPlainText(value) {' : '    function sendAi() {');
const normalizationCode = hasPlainText
  ? block('    function aiPlainText(value) {', '    function sendAi() {') : '';
const sandbox = {
  state: { aiAnchor: null, aiMode: 'chat' },
  document: { getElementById() { return { value: sandbox.target }; } },
  target: '简体中文',
};
vm.createContext(sandbox);
vm.runInContext(promptCode + '\n' + normalizationCode, sandbox, { timeout: 1000 });
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const request = JSON.parse(line);
    let response;
    if (request.op === 'prompt') {
      sandbox.state.aiAnchor = request.quote == null ? null : { quote: request.quote };
      sandbox.state.aiMode = request.mode;
      sandbox.target = request.target || '简体中文';
      sandbox.raw = request.raw || '';
      response = { prompt: vm.runInContext('buildAiPrompt(raw)', sandbox, { timeout: 1000 }) };
    } else if (request.op === 'normalize') {
      sandbox.value = request.text;
      const started = performance.now();
      const text = hasPlainText
        ? vm.runInContext('aiResultText({ok: true, text: value})', sandbox, { timeout: 1000 })
        : String(request.text || '');
      response = { text, normalize_ms: performance.now() - started };
    } else throw new Error('Unknown adapter operation');
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ adapter_error: error.message }) + '\n');
  }
}
