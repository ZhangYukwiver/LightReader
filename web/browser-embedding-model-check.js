async (page) => {
  const context = await page.context().browser().newContext();
  const requests = [];
  context.on('request', request => { if (request.url().includes('.onnx')) requests.push(request.url()); });
  try {
    page = await context.newPage(); await page.goto('http://127.0.0.1:4173/');
    const result = await page.evaluate(async () => {
      const docs = [
        '当人们面对令人焦虑的任务时，会选择短暂逃避来缓解不舒服的感受，从而把工作推迟。',
        '植物通过光合作用将光能转化为化学能，并吸收二氧化碳释放氧气。',
        '法国的首都是巴黎，埃菲尔铁塔坐落在塞纳河畔。',
        '本章介绍排序算法的时间复杂度，快速排序平均为 O(n log n)。'
      ];
      const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
      const results = [], firstVectors = [];
      for (const profile of ['q8', 'fp32']) {
        const client = ReaderEmbedding.create(profile), started = performance.now();
        try {
          await client.init(); const loadedMs = Math.round(performance.now() - started);
          const embeddings = [];
          for (const doc of docs) embeddings.push((await client.embed(doc)).vector);
          const query = (await client.embed('为什么我一直拖着不肯动手？', true)).vector;
          const scores = embeddings.map(vector => dot(query, vector));
          if (scores[0] !== Math.max(...scores)) throw new Error(`${profile}: semantic paraphrase ranked incorrectly: ${scores}`);
          const source = docs.join('\n\n'), parents = [];
          let offset = 0;
          for (const doc of docs) { parents.push({ start: offset, end: offset + doc.length, label: '真实模型验证' }); offset += doc.length + 2; }
          const job = { source: 'test', createdAt: 1, title: '真实模型测试', chunks: parents };
          const kb = await ReaderRag.build(source, job);
          kb.semantic = { version: 1, signature: ReaderEmbedding.signature(profile), dimension: 512, encoding: 'float32le-base64', vectors: embeddings.map(ReaderRag.packVector) };
          const matches = ReaderRag.hybridSearch(kb, '为什么我一直拖着不肯动手？', query);
          if (matches[0]?.start !== 0) throw new Error('Hybrid retrieval lost the correct semantic-only passage');
          const norm = dot(query, query);
          if (Math.abs(norm - 1) > .001) throw new Error('Query vector is not normalized');
          const long = await client.embed('科学实验需要重复核对和记录结果。'.repeat(100));
          if (!(long.tokens > 512 && long.windows > 1 && long.covered === long.tokens)) throw new Error('Long passages are silently truncated');
          firstVectors.push(embeddings[0]);
          results.push({ profile, loadedMs, totalMs: Math.round(performance.now() - started), dimension: query.length, scores, long: { tokens: long.tokens, covered: long.covered, windows: long.windows } });
        } finally { client.close(); }
      }
      return { results, precisionSimilarity: dot(firstVectors[0], firstVectors[1]) };
    });
    if (!requests.some(url => url.endsWith('/model_quantized.onnx')) || !requests.some(url => url.endsWith('/model.onnx'))) throw new Error('Profiles did not load the expected model artifacts');
    await context.route('**/*.onnx', route => route.abort());
    const cached = await page.evaluate(async () => {
      const client = ReaderEmbedding.create('fp32');
      try { await client.init(); return (await client.embed('缓存后的模型仍然可以生成向量')).vector.length === 512; }
      finally { client.close(); }
    });
    if (!cached) throw new Error('Cached model could not be reused');
    return { ...result, cached, inference: 'Real local q8 and fp32 BGE models; no remote inference API.' };
  } finally { await context.close(); }
}
