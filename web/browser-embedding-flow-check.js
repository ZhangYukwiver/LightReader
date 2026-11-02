async (page) => {
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  const checks = [], errors = [], remote = [];
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  await context.addInitScript(() => {
    window.embeddingCalls = 0;
    let api;
    Object.defineProperty(window, 'ReaderEmbedding', { configurable: true, get: () => api,
      set(value) {
        api = { ...value, create(...args) {
          const client = value.create(...args), embed = client.embed.bind(client);
          client.embed = async (text, query) => {
            if (query && window.failQuery) throw new Error('测试夹具：查询推理失败');
            if (!query) window.embeddingCalls++;
            const result = await embed(text, query);
            if (!query && window.pauseAfterOne) {
              window.pauseAfterOne = false;
              setTimeout(() => ReaderBookUI.pauseSemantic(), 0);
            }
            return result;
          };
          return client;
        } };
      } });
  });
  context.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173/')) remote.push(request.url()); });
  try {
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4173/');
    const text = '第一章 情绪\n当人们面对令人焦虑的任务时，会选择短暂逃避来缓解不舒服的感受，从而把工作推迟。\n'
      + '第二章 植物\n植物通过光合作用将光能转化为化学能，并吸收二氧化碳释放氧气。\n'
      + '第三章 地理\n法国的首都是巴黎，埃菲尔铁塔坐落在塞纳河畔。\n'
      + '第四章 算法\n本章介绍排序算法的时间复杂度，快速排序平均为 O(n log n)。';
    await page.locator('#web-file-input').setInputFiles({ name: '语义流程验证.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
    await page.waitForFunction(() => !state.loading && state.title === '语义流程验证.txt');
    await page.evaluate(() => {
      const job = ReaderBook.create(state.text, state.chapters, state.documentInfo.textHash, state.title, '测试夹具：完整分析');
      job.summaries = job.chunks.map(() => '测试夹具摘要'); job.result = '测试夹具全书概要'; job.status = 'done'; job.phase = 'done';
      state.bookAnalysis = job; persistConversation(); window.pauseAfterOne = true;
    });
    const open = async () => {
      await page.locator('.web-ai').click();
      await page.getByRole('button', { name: '整本书分析', exact: true }).click();
    };
    await open();
    await page.waitForFunction(() => document.querySelector('#bookSemanticStatus').textContent.includes('已暂停'), null, { timeout: 60000 });
    const partial = await page.evaluate(async () => (await ReaderBridge.getBookKnowledge(state.documentToken)).data);
    check(partial.semantic.paused && partial.semantic.vectors.length > 0 && partial.semantic.vectors.length < partial.chunks.length,
      'pause persists a real partially embedded index');
    await page.reload(); await page.locator('.recent-item').filter({ hasText: '语义流程验证.txt' }).click(); await open();
    await page.waitForFunction(() => document.querySelector('#bookSemanticStatus').textContent.includes('已暂停'));
    check(await page.evaluate(() => embeddingCalls === 0), 'reopening respects pause without recomputing completed vectors');
    await page.locator('#bookSemanticResume').click();
    await page.waitForFunction(() => document.querySelector('#bookSemanticStatus').textContent.includes('混合检索已就绪'), null, { timeout: 60000 });
    const full = await page.evaluate(async () => ({ kb: (await ReaderBridge.getBookKnowledge(state.documentToken)).data, calls: embeddingCalls }));
    check(full.calls === full.kb.chunks.length - partial.semantic.vectors.length, 'resume embeds only the remaining passages');
    check(full.kb.semantic.signature.endsWith(':fp32') && full.kb.semantic.vectors.length === full.kb.chunks.length, 'web automatically uses and persists the full-precision index');
    await page.locator('#bookKnowledgeSearch > summary').click();
    await page.locator('#bookSearchQuery').fill('为什么我一直拖着不肯动手？'); await page.locator('#bookSearchButton').click();
    await page.waitForSelector('#bookSearchResults summary');
    check(await page.locator('#bookSearchResults blockquote').first().textContent().then(t => t.includes('短暂逃避')), 'real hybrid UI search retrieves a paraphrased source');
    await page.locator('#bookSearchResults summary').first().click();
    await page.screenshot({ path: 'output/playwright/embedding-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#bookSemanticStatus').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/embedding-mobile.png' });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.book-panel').scrollWidth <= innerWidth), 'semantic controls fit the mobile viewport');
    await page.evaluate(() => { window.failQuery = true; });
    await page.locator('#bookSearchQuery').fill('光合作用'); await page.locator('#bookSearchButton').click();
    await page.waitForFunction(() => document.querySelector('#bookSemanticStatus').textContent.includes('查询推理失败'));
    check(await page.locator('#bookSearchResults blockquote').first().textContent().then(t => t.includes('光合作用')), 'query inference failure falls back to lexical evidence');
    await page.evaluate(() => { window.failQuery = false; }); await page.locator('#bookSemanticResume').click();
    await page.waitForFunction(() => document.querySelector('#bookSemanticStatus').textContent.includes('混合检索已就绪'));
    await page.evaluate(async () => {
      window.realSaveKnowledge = ReaderBridge.saveBookKnowledge;
      ReaderBridge.saveBookKnowledge = async (token, raw) => JSON.parse(raw).semantic ? false : realSaveKnowledge(token, raw);
      await ReaderBookUI.buildKnowledge(true);
    });
    await page.waitForFunction(() => document.querySelector('#bookSemanticStatus').textContent.includes('语义向量保存失败'), null, { timeout: 60000 });
    const calls = await page.evaluate(() => embeddingCalls);
    check(await page.evaluate(async () => !(await ReaderBridge.getBookKnowledge(state.documentToken)).data.semantic), 'failed semantic save leaves the persisted lexical index usable');
    await page.evaluate(() => { ReaderBridge.saveBookKnowledge = realSaveKnowledge; }); await page.locator('#bookSemanticResume').click();
    await page.waitForFunction(() => document.querySelector('#bookSemanticStatus').textContent.includes('混合检索已就绪'));
    check(await page.evaluate(async expected => { const kb = (await ReaderBridge.getBookKnowledge(state.documentToken)).data;
      return embeddingCalls === expected && kb.semantic.vectors.length === kb.chunks.length; }, calls),
      'save retry actually persists complete vectors without recomputing them');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload(); await page.locator('.recent-item').filter({ hasText: '语义流程验证.txt' }).click(); await open();
    await page.waitForFunction(() => document.querySelector('#bookSemanticStatus').textContent.includes('混合检索已就绪'));
    check(await page.evaluate(() => embeddingCalls === 0), 'complete vector index is reused after reload');
    check(remote.length === 0, 'no book text or embeddings leave the local origin');
    check(errors.length === 0, 'no browser page errors: ' + errors.join('; '));
    return { checks, realModel: 'fp32', note: 'Analysis reports are fixtures; all embeddings use the real local model.' };
  } catch (error) { throw new Error(`${error.message}\nCompleted: ${checks.join('; ')}`); }
  finally { await context.close(); }
}
