async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  const checks = [], sent = [], errors = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  await context.addInitScript(() => {
    let api;
    Object.defineProperty(window, 'ReaderEmbedding', { configurable: true, get: () => api,
      set(value) { api = { ...value, create() { throw new Error('测试夹具：仅验证分析请求与章节索引'); } }; } });
  });
  try {
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4173/');
    const source = Array.from({ length: 104 }, (_, i) => `第${i + 1}章 小标题\n${'短章节的正文与论据。'.repeat(19)}校验编号ZX${i + 1}\n`).join('');
    await page.locator('#web-file-input').setInputFiles({ name: '短章节性能回归.txt', mimeType: 'text/plain', buffer: Buffer.from(source) });
    await page.waitForFunction(() => state.title === '短章节性能回归.txt' && !state.loading);
    const old = await page.evaluate(() => {
      const job = ReaderBook.create(state.text, state.chapters, state.documentInfo.textHash, state.title, '测试夹具：旧版部分分析');
      job.chunks = job.chunks.flatMap(c => c.sections || [c]); delete job.splitVersion;
      job.summaries = job.chunks.slice(0, 21).map((_, i) => `测试夹具旧摘要 [片段${i + 1}]`);
      state.bookAnalysis = job; persistConversation();
      return { summaries: job.summaries, completed: job.chunks.slice(0, 21), total: job.chunks.length, remaining: ReaderBook.remaining(job) };
    });
    check(old.total === 104 && old.remaining === 119, 'fixture reproduces the excessive request count');
    await page.reload(); await page.locator('.recent-item').filter({ hasText: '短章节性能回归.txt' }).click();
    await page.waitForFunction(() => state.bookAnalysis?.splitVersion === 2);
    const restored = await page.evaluate(() => ({ summaries: state.bookAnalysis.summaries, completed: state.bookAnalysis.chunks.slice(0, 21),
      chunks: state.bookAnalysis.chunks.length, remaining: ReaderBook.remaining(state.bookAnalysis) }));
    check(JSON.stringify(restored.summaries) === JSON.stringify(old.summaries) && JSON.stringify(restored.completed) === JSON.stringify(old.completed), 'automatic migration preserves all completed work and citation positions');
    check(restored.chunks === 24 && restored.remaining === 12, 'remaining work falls from 119 requests to 12');
    await page.locator('.web-ai').click(); await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    check(await page.locator('#bookInfo').innerText().then(t => t.includes('预计剩余 12 次')), 'UI reports remaining requests rather than the old total');
    await page.locator('#bookSheet').getByRole('button', { name: 'AI 渠道', exact: true }).click();
    await page.getByRole('button', { name: '新增渠道', exact: true }).click();
    await page.locator('#aiName').fill('性能回归模拟'); await page.locator('#aiProtocol').selectOption('chat');
    await page.locator('#aiBaseUrl').fill('https://speed-test.invalid/v1'); await page.locator('#aiModel').fill('fixture'); await page.locator('#aiKey').fill('not-a-real-key');
    await page.getByRole('button', { name: '保存渠道', exact: true }).click();
    await page.locator('#aiSettingsSheet').getByRole('button', { name: '完成', exact: true }).click();
    await page.route('https://speed-test.invalid/**', async route => {
      const prompt = route.request().postDataJSON().messages.at(-1).content; sent.push(prompt);
      const index = prompt.match(/这是第 (\d+)\//)?.[1];
      const answer = index ? `模拟新摘要 [片段${index}]` : [...new Set(prompt.match(/\[片段\d+\]/g))].join(' ') + ' 模拟汇总';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: answer } }] }) });
    });
    check(sent.length === 0, 'migration sends no paid requests automatically');
    await page.locator('#bookStart').click();
    await page.waitForFunction(() => state.bookAnalysis?.phase === 'done');
    await page.waitForFunction(() => document.querySelector('#bookKnowledgeStatus').textContent.includes('已就绪'));
    const reads = sent.filter(t => t.includes('任务：分段分析'));
    check(sent.length === 12 && reads.length === 3, 'actual resumed flow uses exactly three reads and nine reductions');
    check(source.slice(0, old.completed.at(-1).end) + reads.map(p => p.split('<原文>\n')[1].split('\n</原文>')[0]).join('') === source,
      'resumed request bodies cover every unread character exactly once');
    check(sent.every(t => t.length < 12000), 'combined requests remain within both transport limits');
    const labels = await page.evaluate(async () => {
      const kb = (await ReaderBridge.getBookKnowledge(state.documentToken)).data;
      return { hit: ReaderRag.search(kb, 'ZX104')[0], sourceCount: state.bookAnalysis.chunks.flatMap(c => c.sections || [c]).length,
        summaries: state.bookAnalysis.summaries.slice(0, 21), remaining: ReaderBook.remaining(state.bookAnalysis) };
    });
    check(labels.hit.label.includes('104') && labels.sourceCount === 104, 'packing keeps precise chapter labels for RAG evidence');
    check(JSON.stringify(labels.summaries) === JSON.stringify(old.summaries) && labels.remaining === 0, 'completed result still contains original paid summaries and zero remaining work');
    check(errors.length === 0, 'no browser page errors: ' + errors.join('; '));
    return { checks, requests: sent.length, provider: 'Simulated responses; no real API key or paid request.' };
  } finally { await context.close(); }
}
