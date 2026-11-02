async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    let api;
    Object.defineProperty(window, 'ReaderEmbedding', { configurable: true, get: () => api,
      set(value) { api = { ...value, create() { throw new Error('测试夹具：本地模型不可用，验证关键词回退'); } }; } });
  });
  const checks = [], errors = [], requests = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  try {
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4173/');
    // Exercise the real version-1 -> version-2 storage migration in this isolated profile.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('lightreader-web', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(new Uint8Array([12, 34, 56]), 'migration-sentinel');
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    }));
    const text = '第一章 背景\n' + '阅读的背景和普通内容。'.repeat(1600)
      + '\n第二章 科学实验\n' + '实验日常记录。'.repeat(1000)
      + '量子纠缠实验使用代号 QX42，两束光子呈现关联。' + '实验后的讨论。'.repeat(1000);
    await page.locator('#web-file-input').setInputFiles({ name: '知识库原文测试.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
    await page.waitForFunction(() => state.title === '知识库原文测试.txt' && !state.loading);
    const migrated = await page.evaluate(() => new Promise(resolve => {
      const request = indexedDB.open('lightreader-web'); request.onsuccess = () => {
        const db = request.result, read = db.transaction('files').objectStore('files').get('migration-sentinel');
        read.onsuccess = () => { resolve(db.version === 2 && db.objectStoreNames.contains('knowledge') && read.result[1] === 34); db.close(); };
      };
    }));
    check(migrated, 'storage upgrade preserves original file store');
    await page.evaluate(() => {
      const job = ReaderBook.create(state.text, state.chapters, state.documentInfo.textHash, state.title, '测试夹具：已完成旧版分析');
      job.summaries = job.chunks.map(() => '测试夹具摘要，不含实验代号');
      job.result = '测试夹具：已有全书分析，不含任何实验细节。'; job.phase = 'done'; job.status = 'done';
      state.bookAnalysis = job; persistConversation();
    });
    await page.reload();
    await page.locator('.recent-item').filter({ hasText: '知识库原文测试.txt' }).click();
    await page.waitForFunction(() => state.bookAnalysis?.result);
    await page.locator('.web-ai').click();
    await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#bookKnowledgeStatus').textContent.includes('已就绪'));
    const originalKb = await page.evaluate(async () => (await ReaderBridge.getBookKnowledge(state.documentToken)).data);
    check(originalKb.chunks.length > 20 && originalKb.method === 'bm25', 'old completed report automatically gains a persisted per-book RAG index');
    check(!JSON.stringify(originalKb).includes('测试夹具摘要') && originalKb.postings.qx42, 'index terms originate from source text, not generated report');
    check(await page.evaluate(() => !JSON.stringify(localStorage).includes('"postings"')), 'large retrieval index is stored separately from chat snapshots');
    await page.locator('#bookKnowledgeSearch > summary').click();
    await page.locator('#bookSearchQuery').fill('QX42');
    await page.getByRole('button', { name: '检索知识库', exact: true }).click();
    await page.locator('#bookSearchResults summary').first().click();
    check(await page.locator('#bookSearchResults blockquote').first().innerText().then(value => value.includes('量子纠缠实验使用代号 QX42')), 'local index search finds original evidence missing from the summary');
    await page.screenshot({ path: 'output/playwright/rag-desktop.png' });

    await page.reload();
    await page.locator('.recent-item').filter({ hasText: '知识库原文测试.txt' }).click();
    await page.waitForFunction(() => state.bookAnalysis?.result);
    await page.locator('.web-ai').click();
    await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#bookKnowledgeStatus').textContent.includes('已就绪'));
    const restoredKb = await page.evaluate(async () => (await ReaderBridge.getBookKnowledge(state.documentToken)).data);
    check(restoredKb.builtAt === originalKb.builtAt, 'reopening loads saved index without rebuilding or needing an API key');
    await page.locator('#bookQuestion').fill('zzunknown98765');
    await page.locator('#bookSend').click();
    check(await page.locator('#bookAnswers').innerText().then(value => value.includes('未检索到相关原文')), 'no-hit question abstains locally without a model call');
    check(requests.length === 0, 'building and local retrieval require no network AI requests');
    await page.locator('#bookSheet').getByRole('button', { name: 'AI 渠道', exact: true }).click();
    await page.getByRole('button', { name: '新增渠道', exact: true }).click();
    await page.locator('#aiName').fill('RAG 模拟验证'); await page.locator('#aiProtocol').selectOption('chat');
    await page.locator('#aiBaseUrl').fill('https://rag-test.invalid/v1');
    await page.locator('#aiModel').fill('mock-rag'); await page.locator('#aiKey').fill('test-not-a-real-key');
    await page.getByRole('button', { name: '保存渠道', exact: true }).click();
    await page.locator('#aiSettingsSheet').getByRole('button', { name: '完成', exact: true }).click();
    let invalid = false;
    await page.route('https://rag-test.invalid/**', async route => {
      const prompt = route.request().postDataJSON().messages.at(-1).content; requests.push(prompt);
      const id = invalid ? 'K999999' : prompt.match(/\[(K\d+)\]/)?.[1];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: `模拟回答：实验代号为 QX42。[${id}]` } }] }) });
    });
    await page.locator('#bookQuestion').fill('量子纠缠实验代号是什么？');
    await page.locator('#bookSend').click();
    await page.waitForFunction(() => state.bookAnalysis.questions.length === 2);
    check(requests[0].includes('QX42') && requests[0].includes('本书 RAG 知识库') && requests[0].length < 12000, 'generation receives bounded retrieved original evidence and citation identifiers');
    const answer = await page.evaluate(() => state.bookAnalysis.questions.at(-1));
    check(answer.sources.length > 0 && !answer.citationWarning, 'valid RAG citation remains linked to actual source offsets');
    invalid = true;
    await page.locator('#bookQuestion').fill('QX42'); await page.locator('#bookSend').click();
    await page.waitForFunction(() => state.bookAnalysis.questions.length === 3);
    check(await page.locator('#bookAnswers').innerText().then(value => value.includes('未提供的引用编号')), 'fabricated citation IDs are disclosed');

    await page.evaluate(async () => {
      const original = ReaderBridge.saveBookKnowledge;
      ReaderBridge.saveBookKnowledge = async () => false;
      try { await ReaderBookUI.buildKnowledge(true); } finally { ReaderBridge.saveBookKnowledge = original; }
    });
    check(await page.locator('#bookKnowledgeStatus').innerText().then(value => value.includes('保存失败')) && await page.locator('#bookSend').isDisabled(), 'index save failure is visible and blocks ungrounded generation');
    await page.locator('#bookKnowledgeRetry').click();
    await page.waitForFunction(() => document.querySelector('#bookKnowledgeStatus').textContent.includes('已就绪'));
    check(requests.length === 2, 'rebuilding only recomputes local index');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#bookKnowledgeStatus').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/rag-mobile.png' });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.book-panel').scrollWidth <= innerWidth), 'knowledge controls fit mobile viewport');

    await page.locator('#bookSheet').getByRole('button', { name: '收起', exact: true }).click();
    const long = '第一章 新书\n' + '另一本书的独有词汇青松。'.repeat(30000);
    await page.locator('#web-file-input').setInputFiles({ name: '取消建库测试.txt', mimeType: 'text/plain', buffer: Buffer.from(long) });
    await page.waitForFunction(() => state.title === '取消建库测试.txt' && !state.loading);
    const cancelId = await page.evaluate(async () => {
      const id = state.documentInfo.textHash;
      state.bookAnalysis = ReaderBook.create(state.text, state.chapters, id, state.title, '测试夹具');
      state.bookAnalysis.result = '测试夹具完整分析'; state.bookAnalysis.phase = 'done'; state.bookAnalysis.status = 'done'; persistConversation();
      const build = ReaderBookUI.buildKnowledge(true); goHome(); await build; return id;
    });
    const cancelled = await page.evaluate(id => new Promise(resolve => {
      const request = indexedDB.open('lightreader-web'); request.onsuccess = () => {
        const db = request.result, read = db.transaction('knowledge').objectStore('knowledge').get(id);
        read.onsuccess = () => { resolve(!read.result); db.close(); };
      };
    }), cancelId);
    check(cancelled, 'switching documents during index build cancels the partial index');
    await page.locator('.recent-item').filter({ hasText: '知识库原文测试.txt' }).click();
    await page.waitForFunction(() => state.bookAnalysis?.result);
    const originalStill = await page.evaluate(async () => (await ReaderBridge.getBookKnowledge(state.documentToken)).data);
    check(originalStill.source === originalKb.source && originalStill.postings.qx42 && !originalStill.postings['青松'], 'another book cannot contaminate the original index');
    check(errors.length === 0, 'no browser page errors: ' + errors.join('; '));
    return { passed: checks.length, checks, provider: 'Simulated generation; isolated fixture books and browser profile.' };
  } finally { await context.close(); }
}
