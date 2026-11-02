async (page) => {
  const context = await page.context().browser().newContext();
  try {
  page = await context.newPage();
  const checks = [];
  const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  await page.goto('http://127.0.0.1:4173/');
  await page.locator('#web-file-input').setInputFiles('output/playwright/edited.docx');
  await page.waitForFunction(() => state.format === 'DOCX' && !state.loading);
  check(await page.locator('#document').innerText().then(text => text.includes('修改后的表格内容')), 'downloaded Word reopens with edited cell');
  await page.locator('#web-file-input').setInputFiles('output/playwright/annotated.pdf');
  await page.waitForFunction(() => state.format === 'PDF' && !state.loading);
  check(await page.evaluate(() => state.pdf.pages.length === 5 && state.pdf.embeddedNotes.some(note => note.contents === 'PDF 中文整页批注')), 'downloaded PDF contains actual annotation and visible notes page');
  await page.locator('#web-file-input').setInputFiles('output/playwright/fixtures/阅读测试.txt');
  await page.waitForFunction(() => state.title === '阅读测试.txt');
  const restored = await page.evaluate(() => {
    const notes = [{ id: 'restore-test', start: 0, end: 3, quote: state.text.slice(0, 3), note: '恢复验证', global: false, orphaned: false }];
    const raw = ReaderNotes.backup(state.documentInfo, notes), original = window.confirm;
    window.confirm = () => true;
    try { onNotesImport(state.documentToken, raw); onNotesImport(state.documentToken, raw); }
    finally { window.confirm = original; closeSheet('notesSheet'); }
    return state.notes.length === 1;
  });
  check(restored, 'notes backup restore and deduplication');
  const quotaSafe = await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('lightreader-web-document:')) throw new DOMException('test quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    try { return ReaderBridge.saveAnnotations(JSON.stringify({ documentToken: state.documentToken, notes: [] })) === false; }
    finally { Storage.prototype.setItem = original; }
  });
  check(quotaSafe, 'storage failure reports unsuccessful save');
  await page.locator('.web-ai').click();
  await page.locator('#aiPage button[aria-label="打开 AI 渠道设置"]').click();
  await page.getByRole('button', { name: '新增渠道', exact: true }).click();
  await page.locator('#aiName').fill('自动化验证（模拟）');
  await page.locator('#aiProtocol').selectOption('chat');
  await page.locator('#aiBaseUrl').fill('https://reader-ai.invalid/v1');
  await page.locator('#aiModel').fill('test-model');
  await page.locator('#aiKey').fill('test-key-never-real');
  await page.getByRole('button', { name: '保存渠道', exact: true }).click();
  await page.waitForFunction(() => state.ai.channels[0]?.hasKey);
  check(await page.evaluate(() => !JSON.stringify(localStorage).includes('test-key-never-real') && !JSON.stringify(sessionStorage).includes('test-key-never-real')), 'API key is absent from persistent browser storage');
  await page.locator('#aiSettingsSheet').getByRole('button', { name: '完成', exact: true }).click();
  let sent;
  await page.route('https://reader-ai.invalid/**', async route => {
    sent = { url: route.request().url(), body: route.request().postDataJSON() };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '模拟 AI 回答，仅用于验证。' } }] }) });
  });
  await page.locator('#aiPagePrompt').fill('测试问题');
  await page.locator('#aiPage .ai-page-actions button').click();
  await page.waitForFunction(() => state.aiPageMessages.some(message => message.text === '模拟 AI 回答，仅用于验证。'));
  check(sent.url.endsWith('/v1/chat/completions') && sent.body.messages.at(-1).content === '测试问题', 'Chat endpoint and request payload');
  check(!JSON.stringify(sent.body).includes('第一章 阅读测试'), 'standalone AI does not send document text');
  await page.unroute('https://reader-ai.invalid/**');
  await page.route('https://reader-ai.invalid/**', route => route.abort('failed'));
  await page.locator('#aiPagePrompt').fill('网络失败验证');
  await page.locator('#aiPage .ai-page-actions button').click();
  await page.waitForFunction(() => state.aiPageMessages.some(message => message.error));
  check(await page.locator('#aiPageMessages').innerText().then(text => text.includes('CORS')), 'network/CORS error is actionable');
  await page.unroute('https://reader-ai.invalid/**');
  await page.locator('#aiPage button[aria-label="打开 AI 渠道设置"]').click();
  await page.locator('#aiProtocol').selectOption('responses');
  await page.locator('#aiChannelWebSearch').check();
  await page.getByRole('button', { name: '保存渠道', exact: true }).click();
  await page.locator('#aiSettingsSheet').getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('#aiPageWebSearch').check();
  await page.route('https://reader-ai.invalid/**', async route => {
    sent = { url: route.request().url(), body: route.request().postDataJSON() };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '模拟 Responses 回答', annotations: [{ type: 'url_citation', url: 'https://example.com/', title: '测试引用' }] }] }] }) });
  });
  await page.locator('#aiPagePrompt').fill('Responses 验证');
  await page.locator('#aiPage .ai-page-actions button').click();
  await page.waitForFunction(() => state.aiPageMessages.some(message => message.text === '模拟 Responses 回答'));
  check(sent.url.endsWith('/v1/responses') && sent.body.tools[0].type === 'web_search', 'Responses endpoint, tools and output parsing');
  check(await page.getByRole('button', { name: '联网来源：测试引用', exact: true }).count() === 1, 'AI citations render');
  await page.screenshot({ path: 'output/playwright/ai-desktop.png' });
  await page.reload();
  await page.locator('.recent-item').filter({ hasText: '阅读测试.txt' }).click();
  await page.waitForFunction(() => state.title === '阅读测试.txt');
  check(await page.evaluate(() => state.aiPageMessages.some(message => message.text === '模拟 Responses 回答')), 'AI conversation survives reload');
  check(await page.evaluate(() => !state.ai.channels[0].hasKey), 'API key expires on reload');
  const second = await context.newPage();
  await second.goto('http://127.0.0.1:4173/');
  await second.locator('.recent-item').filter({ hasText: '阅读测试.txt' }).click();
  await second.waitForFunction(() => state.title === '阅读测试.txt');
  check(await page.evaluate(() => ReaderBridge.saveAnnotations(JSON.stringify({ documentToken: state.documentToken, notes: [] })) === false), 'stale tab cannot overwrite another tab');
  await second.close();
  await page.locator('.web-library').click();
  const long = await page.evaluate(async () => {
    const text = '第一章 大文本\n' + '本地阅读与保存。\n'.repeat(20000);
    await ReaderWeb.importFile(new File([text], '长文验证.txt', { type: 'text/plain' }));
    return text.length;
  });
  await page.waitForFunction(length => !state.loading && state.text.length === length, long);
  check(await page.evaluate(() => state.text.endsWith('本地阅读与保存。\n')), 'large TXT chunk loading');
  await page.locator('#displayButton').click();
  check(await page.locator('#settingsSheet').isVisible(), 'TXT display button opens reading settings');
  return { passed: checks.length, checks, ai: 'Mock transport only; no real provider or key used.' };
  } finally { await context.close(); }
}
