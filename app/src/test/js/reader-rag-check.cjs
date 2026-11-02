const assert = require('node:assert/strict');
const rag = require('../../main/assets/reader-rag.js');
const book = require('../../main/assets/reader-book.js');

(async () => {
  assert(rag.tokens('章节6的观点和论据').includes('观点'), 'Digits must not swallow following Chinese terms');
  assert(rag.tokens('模型GPT和量子纠缠').includes('量子'), 'Latin words must not swallow following Chinese terms');
  const text = '第一章 背景\n' + '普通的森林与海洋。'.repeat(250) + '\n第二章 实验\n'
    + '一般实验记录。'.repeat(300) + '量子纠缠实验编号 QX42，结果为两束光子相关。'
    + '后续记录。'.repeat(300) + '\n第三章 热学\n熵描述状态数量。Entropy measures multiplicity.\n最后标记';
  const headings = [{ start: 0, title: '第一章' }, { start: text.indexOf('第二章'), title: '第二章' }, { start: text.indexOf('第三章'), title: '第三章' }];
  const job = book.create(text, headings, 'source-a', '测试', '全文'); job.result = '概要';
  const kb = await rag.build(text, job);
  assert(rag.matches(kb, job, text.length));
  assert(kb.chunks.every(chunk => chunk.end - chunk.start <= 1100));
  assert.equal(new Set(kb.chunks.map(c => c.id)).size, kb.chunks.length);
  const covered = new Uint8Array(text.length);
  kb.chunks.forEach(c => covered.fill(1, c.start, c.end));
  for (let i = 0; i < text.length; i++) assert(covered[i] || !text[i].trim(), `Unindexed source at ${i}`);
  const hit = rag.search(kb, '量子纠缠的实验是什么？')[0];
  assert(text.slice(hit.start, hit.end).includes('QX42'), 'Relevant passage was missed deep inside a chapter');
  assert(text.slice(rag.search(kb, 'QX42')[0].start, rag.search(kb, 'QX42')[0].end).includes('QX42'));
  assert(rag.search(kb, '熵是什么？').some(h => text.slice(h.start, h.end).includes('熵描述')));
  assert(rag.search(kb, 'ENTROPY').some(h => text.slice(h.start, h.end).includes('Entropy')));
  assert.equal(rag.search(kb, 'ENTROPY')[0].label, '第三章', 'Packed analysis must retain precise RAG chapter labels');
  assert.deepEqual(rag.search(kb, 'zxqmissing987'), [], 'Unmatched query fell back to arbitrary early passages');
  const restored = JSON.parse(JSON.stringify(kb));
  assert.deepEqual(rag.search(restored, '量子纠缠'), rag.search(kb, '量子纠缠'), 'Saved index changed retrieval');
  assert(!rag.matches(kb, { ...job, source: 'source-b' }, text.length));
  assert(!rag.matches(kb, { ...job, createdAt: job.createdAt + 1 }, text.length));
  assert(!rag.matches(kb, job, text.length + 1));
  const task = book.question(job, text, '量子纠缠', kb);
  assert(task.sources.length > 0 && task.sources.length <= 4 && task.prompt.length < 12000);
  book.accept(job, { ...task, text: '答案引用了错误编号 [K999999]' });
  assert(job.questions.at(-1).citationWarning, 'Invalid model citations should be disclosed');
  assert.throws(() => book.question({ ...job, source: 'changed' }, text, '量子纠缠', kb));
  let stopped = false;
  await assert.rejects(rag.build(text, job, { progress: () => { stopped = true; }, cancelled: () => stopped }), /取消/);
  console.log('ReaderRagCheck OK: original coverage, deep retrieval, Chinese/English terms, persistence, stale/cancel guards, citations');
})().catch(error => { console.error(error); process.exitCode = 1; });
