/* All tokenization and model inference stay in this worker and on this device. */
let library, tokenizer, model, profile, queue = Promise.resolve();
const DIMENSION = 512, QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

async function init(dtype, id) {
  if (model) { if (dtype !== profile) throw new Error('模型精度已改变，请重新加载'); return; }
  library ||= await import('./vendor/embedding/transformers.min.js');
  const { env, AutoTokenizer, AutoModel } = library;
  env.allowRemoteModels = false; env.allowLocalModels = true;
  env.localModelPath = new URL('./vendor/embedding/models/', self.location.href).href;
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = new URL('./vendor/embedding/ort/', self.location.href).href;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  const options = { local_files_only: true, progress_callback: event => {
    self.postMessage({ id, progress: { status: event.status, file: event.file, loaded: event.loaded, total: event.total, progress: event.progress } });
  } };
  [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained('bge-small-zh-v1.5', options),
    AutoModel.from_pretrained('bge-small-zh-v1.5', { ...options, dtype, device: 'wasm' })
  ]);
  profile = dtype;
}

async function embed(text, query) {
  // Encode without truncation, then cover every token using overlapping model-sized windows.
  const ids = tokenizer((query ? QUERY_PREFIX : '') + text, { add_special_tokens: false, truncation: false, return_tensor: false }).input_ids;
  const special = tokenizer('', { return_tensor: false }).input_ids;
  const result = new Float32Array(DIMENSION);
  let windows = 0, covered = 0;
  for (let start = 0; start < Math.max(1, ids.length); start += 430) {
    const end = Math.min(ids.length, start + 510), input = [special[0], ...ids.slice(start, end), special.at(-1)];
    const dims = [1, input.length];
    const outputs = await model({
      input_ids: new library.Tensor('int64', BigInt64Array.from(input, BigInt), dims),
      attention_mask: new library.Tensor('int64', new BigInt64Array(input.length).fill(1n), dims),
      token_type_ids: new library.Tensor('int64', new BigInt64Array(input.length), dims)
    });
    const hidden = outputs.last_hidden_state;
    if (!hidden || hidden.dims.at(-1) !== DIMENSION) throw new Error('模型输出维度不匹配');
    let norm = 0;
    for (let i = 0; i < DIMENSION; i++) norm += hidden.data[i] ** 2;
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || !norm) throw new Error('模型返回了无效向量');
    for (let i = 0; i < DIMENSION; i++) result[i] += hidden.data[i] / norm;
    for (const tensor of Object.values(outputs)) tensor.dispose?.();
    windows++; covered = end;
    if (end === ids.length) break;
  }
  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  if (!norm || !Number.isFinite(norm)) throw new Error('无法归一化语义向量');
  for (let i = 0; i < result.length; i++) result[i] /= norm;
  return { vector: result, tokens: ids.length, covered, windows };
}

self.onmessage = event => {
  const message = event.data;
  queue = queue.catch(() => {}).then(async () => {
    try {
      if (!['q8', 'fp32'].includes(message.profile)) throw new Error('不支持的模型精度');
      await init(message.profile, message.id);
      const result = message.type === 'init' ? { profile, dimension: DIMENSION } : await embed(String(message.text || ''), Boolean(message.query));
      self.postMessage({ id: message.id, result }, result.vector ? [result.vector.buffer] : []);
    } catch (error) { self.postMessage({ id: message.id, error: error.message || '本地模型运行失败' }); }
  });
};
