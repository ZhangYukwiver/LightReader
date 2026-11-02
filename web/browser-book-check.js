async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    let api;
    Object.defineProperty(window, 'ReaderEmbedding', { configurable: true, get: () => api,
      set(value) { api = { ...value, create() { throw new Error('测试夹具：本地模型不可用，验证关键词回退'); } }; } });
  });
  const checks = [], errors = [], sent = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  try {
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4173/');
    const book = Array.from({ length: 6 }, (_, i) => `第${i + 1}章 测试章节\n${`章节${i + 1}的观点和论据。`.repeat(850)}\n本章结束${i + 1}\n`).join('\n') + '全文最终标记';
    await page.locator('#web-file-input').setInputFiles({ name: '全书分析测试.txt', mimeType: 'text/plain', buffer: Buffer.from(book) });
    await page.waitForFunction(() => state.title === '全书分析测试.txt' && !state.loading);
    await page.locator('.web-ai').click();
    await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    check(await page.locator('#bookInfo').innerText().then(s => s.includes('预计')), 'cost/request preview visible before sending');
    check(sent.length === 0, 'opening panel sends no book text');
    await page.locator('#bookSheet').getByRole('button', { name: 'AI 渠道', exact: true }).click();
    await page.getByRole('button', { name: '新增渠道', exact: true }).click();
    await page.locator('#aiName').fill('全书测试（模拟）');
    await page.locator('#aiProtocol').selectOption('chat');
    await page.locator('#aiBaseUrl').fill('https://book-test.invalid/v1');
    await page.locator('#aiModel').fill('mock-book-model');
    await page.locator('#aiKey').fill('mock-key');
    await page.getByRole('button', { name: '保存渠道', exact: true }).click();
    await page.waitForFunction(() => state.ai.channels[0]?.hasKey);
    await page.locator('#aiSettingsSheet').getByRole('button', { name: '完成', exact: true }).click();
    let held, hold = true, fail = false;
    const reply = async route => {
      const body = route.request().postDataJSON(), prompt = body.messages?.at(-1).content || body.input;
      sent.push(prompt);
      if (fail) { fail = false; await route.fulfill({ status: 503, body: 'temporary error' }); return; }
      const part = prompt.match(/这是第 (\d+)\//)?.[1];
      const answer = part ? `模拟分段分析 [片段${part}]：本段呈现观点及论据。`
        : prompt.includes('任务：全书问答') ? '模拟问答：请核对本次原文。 [片段1]'
        : prompt.includes('任务：全书汇总') ? '模拟全书报告\n\n全书概要：六章循序展开。\n章节脉络与核心观点：[片段1] [片段6]\n值得思考的问题：论据是否充分？'
        : [...new Set(prompt.match(/\[片段\d+\]/g))].join(' ') + ' 模拟阶段汇总';
      const payload = { status: 200, contentType: 'application/json', body: JSON.stringify(body.input
        ? { output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] }
        : { choices: [{ message: { content: answer } }] }) };
      if (hold) { hold = false; held = () => route.fulfill(payload); } else await route.fulfill(payload);
    };
    await page.route('https://book-test.invalid/**', reply);
    await page.locator('#bookStart').click();
    await page.waitForFunction(() => Boolean(state.bookAnalysis?.pending));
    while (!held) await page.waitForTimeout(20);
    await page.locator('#bookPause').click(); await held(); held = null;
    await page.waitForFunction(() => state.bookAnalysis.summaries.length === 1 && !state.bookAnalysis.pending);
    check(sent.length === 1, 'pause stops scheduling after current request');
    await page.reload();
    await page.locator('.recent-item').filter({ hasText: '全书分析测试.txt' }).click();
    await page.waitForFunction(() => !state.loading && state.bookAnalysis?.summaries.length === 1);
    await page.locator('.web-ai').click();
    await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    check(await page.locator('#bookStart').innerText() === '继续分析', 'resume after reload keeps completed segment');
    await page.locator('#bookSheet').getByRole('button', { name: 'AI 渠道', exact: true }).click();
    await page.locator('#aiKey').fill('mock-key');
    await page.getByRole('button', { name: '保存渠道', exact: true }).click();
    await page.locator('#aiSettingsSheet').getByRole('button', { name: '完成', exact: true }).click();
    fail = true;
    await page.locator('#bookStart').click();
    await page.waitForFunction(() => state.bookAnalysis.status === 'error');
    check(await page.evaluate(() => state.bookAnalysis.summaries.length === 1), 'failed segment does not advance progress');
    const retryStart = sent.length;
    await page.locator('#bookStart').click();
    await page.waitForFunction(() => state.bookAnalysis?.phase === 'done');
    await page.waitForFunction(() => document.querySelector('#bookKnowledgeStatus').textContent.includes('已就绪'));
    check(await page.evaluate(async () => Boolean((await ReaderBridge.getBookKnowledge(state.documentToken)).data?.postings)), 'completed analysis automatically persists its RAG index');
    const result = await page.evaluate(() => ({ chunks: state.bookAnalysis.chunks, summaries: state.bookAnalysis.summaries, result: state.bookAnalysis.result }));
    check(result.summaries.length === result.chunks.length, 'all source chunks analyzed');
    const reads = [sent[0], ...sent.slice(retryStart).filter(p => p.includes('任务：分段分析'))];
    check(reads.map(p => p.split('<原文>\n')[1].split('\n</原文>')[0]).join('') === book, 'actual request payloads cover complete original book exactly');
    check(sent.every(p => p.length < 12000), 'no transport truncation');
    check(sent.some(p => p.includes('合并阶段摘要')) && result.result.includes('模拟全书报告'), 'hierarchical reduction reaches final report');
    await page.screenshot({ path: 'output/playwright/book-desktop.png' });
    await page.locator('#bookQuestion').fill('第六章有哪些观点？');
    await page.locator('#bookSend').click();
    await page.waitForFunction(() => state.bookAnalysis.questions.length === 1);
    check(sent.at(-1).includes('<原文片段>') && sent.at(-1).includes('<全书概要>'), 'Q&A contains synopsis and retrieved original text');
    await page.locator('#bookAnswers summary').click();
    const evidenceCount = await page.locator('#bookAnswers blockquote').count();
    check(evidenceCount > 0 && evidenceCount <= 4, 'Q&A source evidence is inspectable');
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#bookExport').click(); const download = await downloadEvent;
    await download.saveAs('output/playwright/book-report.md');
    check(download.suggestedFilename().endsWith('.md'), 'report downloads as Markdown');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.book-panel').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: 'output/playwright/book-mobile.png' });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.book-panel').scrollWidth <= innerWidth), 'mobile report has no horizontal overflow');
    await page.locator('#bookSources > summary').click();
    await page.locator('#bookChunks > details').first().locator('summary').click();
    await page.locator('#bookChunks > details').first().getByRole('button').click();
    check(await page.locator('#bookSheet').isHidden() && await page.evaluate(() => getSelection().toString().length > 0), 'source action returns to original selection');
    await page.reload();
    await page.locator('.recent-item').filter({ hasText: '全书分析测试.txt' }).click();
    await page.waitForFunction(() => state.bookAnalysis?.questions.length === 1);
    check(await page.evaluate(() => state.bookAnalysis.phase === 'done'), 'completed report and questions persist after reload');

    // A late response must remain with its originating document and never auto-send the next chunk.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#web-file-input').setInputFiles({ name: '另一本.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 内容\n' + '另一本的正文。'.repeat(1200)) });
    await page.waitForFunction(() => state.title === '另一本.txt');
    await page.locator('.web-ai').click();
    await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    await page.locator('#bookSheet').getByRole('button', { name: 'AI 渠道', exact: true }).click();
    await page.locator('#aiKey').fill('mock-key');
    await page.getByRole('button', { name: '保存渠道', exact: true }).click();
    await page.locator('#aiSettingsSheet').getByRole('button', { name: '完成', exact: true }).click();
    hold = true;
    await page.locator('#bookStart').click(); while (!held) await page.waitForTimeout(20);
    await page.locator('#bookSheet').getByRole('button', { name: '收起', exact: true }).click();
    await page.locator('.web-library').click();
    await held(); held = null;
    await page.waitForTimeout(150);
    check(await page.evaluate(() => !state.bookAnalysis), 'late result does not populate another document');
    await page.locator('.recent-item').filter({ hasText: '另一本.txt' }).click();
    await page.waitForFunction(() => state.bookAnalysis?.summaries.length === 1);
    check(await page.evaluate(() => !state.bookAnalysis.pending && state.bookAnalysis.status === 'paused'), 'late result restored without automatic continuation');

    await page.locator('#web-file-input').setInputFiles('output/playwright/fixtures/Word测试.docx');
    await page.waitForFunction(() => state.format === 'DOCX' && !state.loading);
    await page.locator('.web-ai').click();
    await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    const beforeQuota = sent.length;
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('lightreader-web-document:')) throw new DOMException('test quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
      try { ReaderBookUI.start(); } finally { Storage.prototype.setItem = original; }
    });
    check(sent.length === beforeQuota && await page.locator('#bookError').innerText().then(s => s.includes('保存失败')), 'storage failure stops before sending a paid request');
    await page.locator('#bookStart').click();
    await page.waitForFunction(() => state.bookAnalysis?.phase === 'done');
    check(sent.slice(beforeQuota).some(s => s.includes('原来的内容')), 'DOCX table text enters analysis');
    await page.locator('#bookSheet').getByRole('button', { name: '收起', exact: true }).click();
    await page.locator('#displayButton').click();
    await page.evaluate(() => { const cell = document.querySelectorAll('#document td')[1], range = document.createRange(); range.selectNodeContents(cell); getSelection().removeAllRanges(); getSelection().addRange(range); });
    await page.keyboard.insertText('修改后的不同版本');
    await page.locator('#displayButton').click();
    await page.locator('.web-ai').click();
    await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    check(await page.locator('#bookStatus').innerText().then(s => s.includes('正文已修改')) && await page.locator('#bookSend').isDisabled(), 'edited source invalidates old report and Q&A');
    check(await page.locator('#bookResult').innerText().then(s => s.includes('模拟全书报告')), 'old report remains exportable after edits');
    await page.locator('#bookSheet').getByRole('button', { name: '收起', exact: true }).click();
    await page.locator('#web-file-input').setInputFiles('output/playwright/fixtures/check.pdf');
    await page.waitForFunction(() => state.format === 'PDF' && !state.loading);
    await page.locator('.web-ai').click();
    await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    check(await page.locator('#bookInfo').innerText().then(s => s.includes('第 2 页无可提取文字')), 'image-only PDF page is explicitly excluded from claimed coverage');
    await page.locator('#bookSheet').getByRole('button', { name: 'AI 渠道', exact: true }).click();
    await page.locator('#aiProtocol').selectOption('responses');
    await page.getByRole('button', { name: '保存渠道', exact: true }).click();
    await page.locator('#aiSettingsSheet').getByRole('button', { name: '完成', exact: true }).click();
    await page.locator('#bookStart').click();
    await page.waitForFunction(() => state.bookAnalysis?.phase === 'done');
    check(await page.evaluate(() => state.bookAnalysis.summaries.length === state.bookAnalysis.chunks.length
      && state.bookAnalysis.chunks.flatMap(c => c.sections || [c]).length === 4
      && state.bookAnalysis.coverage.includes('未分析')), 'packed PDF analysis retains all page boundaries and the coverage warning');
    check(errors.length === 0, 'no uncaught browser errors: ' + errors.join('; '));
    return { passed: checks.length, checks, provider: 'Explicit simulated provider; no real API key or model call.' };
  } finally { await context.close(); }
}
