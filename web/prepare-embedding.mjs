import { mkdir, copyFile, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const run = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(root, '../app/src/main/assets/vendor/embedding');
const model = 'bge-small-zh-v1.5', revision = '75c43b069aac4d136ba6bc1122f995fedcfd2781';
const base = `https://huggingface.co/Xenova/${model}/resolve/${revision}/`;
const modelDir = path.join(assets, 'models', model);
const webModel = path.join(root, '.embedding-cache/model.onnx');
await mkdir(path.join(modelDir, 'onnx'), { recursive: true });
await mkdir(path.dirname(webModel), { recursive: true });
await mkdir(path.join(assets, 'ort'), { recursive: true });
for (const [from, to] of [
  ['@huggingface/transformers/dist/transformers.min.js', 'transformers.min.js'],
  ['@huggingface/transformers/LICENSE', 'transformers-LICENSE'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', 'ort/ort-wasm-simd-threaded.jsep.mjs'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', 'ort/ort-wasm-simd-threaded.jsep.wasm']
]) await copyFile(path.join(root, 'node_modules', from), path.join(assets, to));
try { await stat(path.join(assets, 'onnxruntime-LICENSE')); }
catch { await run('curl', ['--location', '--fail', '--silent', '--show-error', '--retry', '2', '--max-time', '30', '--output',
  path.join(assets, 'onnxruntime-LICENSE'), 'https://raw.githubusercontent.com/microsoft/onnxruntime/89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0/LICENSE']); }

async function download(file, target, hash, size) {
  try {
    const bytes = await readFile(target);
    if (hash ? bytes.length === size && createHash('sha256').update(bytes).digest('hex') === hash : bytes.length > 0) return;
  } catch { /* Fetch only missing or invalid resources. */ }
  console.log(`准备 Embedding 资源：${file}`);
  const temporary = target + '.download';
  try {
    await run('curl', ['--location', '--fail', '--silent', '--show-error', '--retry', '3', '--max-time', '300', '--output', temporary, base + file]);
    const bytes = await readFile(temporary);
    if (hash && (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== hash)) throw new Error(`模型校验失败：${file}`);
    if (file.endsWith('.json')) JSON.parse(bytes.toString());
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json']) {
  await download(file, path.join(modelDir, file));
}
await download('onnx/model_quantized.onnx', path.join(modelDir, 'onnx/model_quantized.onnx'),
  '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc', 24010842);
await download('onnx/model.onnx', webModel,
  '69a0b846f4f116b5e6aabf9546ea6754d02264f3211a13a1bd69b31b8040749a', 94851877);
await writeFile(path.join(assets, 'MODEL-NOTICE.txt'), `Model: BAAI/bge-small-zh-v1.5 (model card declares MIT)\nhttps://huggingface.co/BAAI/bge-small-zh-v1.5\nONNX conversion: Xenova/${model}\nRevision: ${revision}\nhttps://huggingface.co/Xenova/${model}\nRuntime licenses are included alongside this notice.\n`);
await writeFile(path.join(assets, 'manifest.json'), JSON.stringify({ model, revision, dimension: 512,
  mobile: { dtype: 'q8', bytes: 24010842 }, web: { dtype: 'fp32', bytes: (await stat(webModel)).size } }, null, 2));
console.log('Embedding 资源已准备：Android 24.0 MB 量化模型；网页 94.9 MB 全精度模型。');
