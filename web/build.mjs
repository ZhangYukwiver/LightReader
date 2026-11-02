import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './prepare-embedding.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(root, '../app/src/main/assets');
const output = path.join(root, 'dist');
await mkdir(path.join(output, 'vendor/web'), { recursive: true });
for (const file of ['reader-notes.js', 'reader-book.js', 'reader-rag.js', 'reader-embedding.js', 'reader-embedding-worker.js', 'reader-pdf.js', 'reader-pdf.css', 'reader-pdf-export.js', 'vendor']) {
  await cp(path.join(source, file), path.join(output, file), { recursive: true });
}
await cp(path.join(root, '.embedding-cache/model.onnx'), path.join(output, 'vendor/embedding/models/bge-small-zh-v1.5/onnx/model.onnx'));
for (const file of ['web-bridge.js', 'web-docx.js', 'web-ui.js', 'web.css', 'favicon.svg']) {
  await cp(path.join(root, file), path.join(output, file));
}
for (const [from, to] of [
  ['fflate/umd/index.js', 'fflate.js'], ['fflate/LICENSE', 'fflate-LICENSE'],
  ['js-sha256/build/sha256.min.js', 'sha256.js'], ['js-sha256/LICENSE.txt', 'sha256-LICENSE.txt']
]) await cp(path.join(root, 'node_modules', from), path.join(output, 'vendor/web', to));
let html = await readFile(path.join(source, 'reader.html'), 'utf8');
html = html.replace('initial-scale=1,maximum-scale=1,user-scalable=no', 'initial-scale=1')
  .replace('<title>轻阅</title>', '<title>轻阅 · 网页阅读器</title>')
  .replace('</head>', '<link rel="icon" href="favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="web.css"></head>')
  .replace('<script src="reader-notes.js">', '<script src="vendor/web/fflate.js"></script><script src="vendor/web/sha256.js"></script><script src="web-docx.js"></script><script src="web-bridge.js"></script><script src="web-ui.js"></script>\n  <script src="reader-notes.js">')
  .replace('只移除轻阅中的项目记录，不会删除原文件。', '将删除本浏览器中的文件副本、批注、草稿和对话，不影响电脑上的原文件。重要内容请先导出。')
  .replace('API Key 只在本机使用 Android Keystore 加密保存；地址必须是 HTTPS，可填基础地址或完整接口地址。', 'API Key 仅保存在当前页面内存，刷新后需重新填写；渠道信息保存在本浏览器。地址必须为 HTTPS，服务商须允许浏览器跨域访问。');
await writeFile(path.join(output, 'index.html'), html);
console.log('已生成 web/dist（复用 Android 阅读页面及 PDF / 批注模块）');
