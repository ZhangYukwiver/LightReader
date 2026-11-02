const assert = require('node:assert/strict');
const book = require('../../main/assets/reader-book.js');
const rag = require('../../main/assets/reader-rag.js');

(async () => {

// An entire long document, including its last character, must enter exactly one source request.
const text = '序言\n' + '甲乙😀\n'.repeat(30000) + '全文结束';
const headings = [{ start: 0, title: '序言' }, { start: 75004, title: '第二章' }];
const job = book.create(text, headings, 'source-hash', '长书测试', '全部正文');
assert.equal(job.chunks.map(c => text.slice(c.start, c.end)).join(''), text);
assert(job.chunks.every(c => c.end - c.start <= 7000));
let calls = 0, allRead = '', mergeRounds = new Set();
while (job.phase !== 'done') {
  const remaining = book.remaining(job);
  const task = book.next(job, text); calls++;
  assert(task.prompt.length < 12000, 'Bridge would silently truncate the prompt');
  if (task.kind === 'read') allRead += text.slice(job.chunks[task.index].start, job.chunks[task.index].end);
  else mergeRounds.add(job.round);
  const refs = task.kind === 'read' ? `[片段${task.index + 1}]` : [...new Set(task.prompt.match(/\[片段\d+\]/g))].join(' ');
  book.accept(job, { ...task, text: refs });
  assert.equal(book.remaining(job), remaining - 1, 'Remaining requests should count work still to run');
}
assert.equal(allRead, text);
assert.equal(calls, book.requests(job.chunks.length));
assert(mergeRounds.size > 1, 'Long books need hierarchical reduction');
for (let i = 1; i <= job.chunks.length; i++) assert(job.result.includes(`[片段${i}]`));
assert.equal(job.status, 'done');

// Many short Word headings must not each trigger a separate paid request.
let shortText = '';
const shortHeadings = [], oldChunks = [];
for (let i = 0; i < 104; i++) {
  const start = shortText.length, title = `小节 ${i + 1}`;
  shortHeadings.push({ start, title });
  shortText += title + '\n' + '短章节的正文与论据。'.repeat(20) + '\n';
  oldChunks.push({ start, end: shortText.length, label: title });
}
const packed = book.create(shortText, shortHeadings, 'short-sections', '多小标题文档', '全文');
assert(packed.chunks.length <= 4, 'Short sections were not combined within the input budget');
assert.equal(packed.chunks.map(c => shortText.slice(c.start, c.end)).join(''), shortText);
assert.deepEqual(packed.chunks.flatMap(c => c.sections), oldChunks, 'Original section offsets and titles must survive packing');
assert.equal(book.requests(packed.chunks.length), 5);
const legacy = { ...packed, splitVersion: undefined, chunks: oldChunks, summaries: oldChunks.slice(0, 21).map((_, i) => `已保存的分析 [片段${i + 1}]`) };
const completed = JSON.stringify({ chunks: legacy.chunks.slice(0, 21), summaries: legacy.summaries, createdAt: legacy.createdAt });
const pending = JSON.parse(JSON.stringify({ ...legacy, pending: { kind: 'read', index: 21, pending: true } }));
assert.equal(book.compactPending(pending), false, 'Never regroup an in-flight request');
const merging = JSON.parse(JSON.stringify({ ...legacy, phase: 'merging' }));
assert.equal(book.compactPending(merging), false, 'Never change the sources of an existing reduction pass');
assert(book.compactPending(legacy));
assert.equal(JSON.stringify({ chunks: legacy.chunks.slice(0, 21), summaries: legacy.summaries, createdAt: legacy.createdAt }), completed, 'Previously paid analysis and citation numbers changed');
assert(legacy.chunks.length <= 24 && book.remaining(legacy) <= 12);
assert.equal(legacy.chunks.map(c => shortText.slice(c.start, c.end)).join(''), shortText, 'Resumed plan lost or duplicated source text');
assert.equal(book.compactPending(legacy), false, 'Migration should only run once');
const firstPending = book.next(legacy, shortText);
assert.equal(firstPending.index, 21);
assert(firstPending.prompt.includes(shortText.slice(oldChunks[21].start, oldChunks[21].end)));
assert(firstPending.prompt.length < 12000);

const retry = book.create('第一章\n一些内容', [], 'hash', '短书', '全部正文');
const task = book.next(retry, '第一章\n一些内容');
book.accept(retry, { ...task, error: true, text: '网络失败' });
assert.equal(retry.summaries.length, 0);
assert.equal(book.next(retry, '第一章\n一些内容').index, 0);
book.accept(retry, { ...task, text: '超'.repeat(1801) });
assert.equal(retry.summaries.length, 0, 'Never silently truncate a model response');
assert.equal(retry.status, 'error');
book.accept(retry, { ...task, text: 'AI 没有返回文字结果。' });
assert.equal(retry.summaries.length, 0, 'A transport placeholder is not an analysis');
book.accept(retry, { ...task, text: '本段概要' });
assert.equal(retry.summaries.length, 1);

const qaText = '普通内容。'.repeat(2000) + '量子纠缠的解释在这里。' + '结束。'.repeat(2000);
const qaJob = book.create(qaText, [], 'hash', '测试', '全文');
qaJob.result = '概'.repeat(3500);
const knowledge = await rag.build(qaText, qaJob);
const qa = book.question(qaJob, qaText, '量子纠缠是什么？', knowledge);
assert(qa.prompt.length < 12000);
assert(qa.sources.some(s => qaText.slice(s.start, s.end).includes('量子纠缠的解释在这里')));
assert(qa.sources.every(s => s.start >= 0 && s.end <= qaText.length && s.end - s.start <= 3000));
book.accept(qaJob, { ...qa, text: '原文中的解释 [片段2]' });
assert.equal(qaJob.questions.length, 1);
console.log('ReaderBookCheck OK: source coverage, bounded prompts, short-section packing, lossless partial-job migration, remaining requests, hierarchical merge, retry, retrieval');
})().catch(error => { console.error(error); process.exitCode = 1; });
