const assert = require('node:assert/strict');
const notes = require('../../main/assets/reader-notes.js');
const original = { id: 'one', start: 0, end: 5, quote: 'alpha', note: '保留说明', global: false, orphaned: false };
const document = { title: '示例.txt', textHash: 'a'.repeat(64), format: 'TXT' };

assert.equal(notes.reanchor([original], 'alpha beta', 'beta')[0].orphaned, true);
assert.equal(notes.reanchor([original], 'alpha beta', 'alpha alpha')[0].orphaned, true);
assert.equal(notes.reanchor([original], 'alpha beta', 'new alpha beta')[0].start, 4);
const detached = notes.normalize([{ ...original, start: undefined, end: undefined }], 'changed');
assert.equal(detached[0].orphaned, true);
const backup = notes.parseBackup(notes.backup(document, detached));
assert.equal(backup.notes[0].note, original.note);
assert.equal(backup.notes[0].quote, original.quote);

let result = notes.merge([], [original], 'alpha beta', true);
assert.equal(result.added, 1);
assert.equal(result.notes[0].orphaned, false);
result = notes.merge(result.notes, [original], 'alpha beta', true);
assert.equal(result.added, 0);
assert.equal(result.skipped, 1);
const changed = { ...original, note: '另一个版本' };
result = notes.merge(result.notes, [changed], 'alpha beta', true);
assert.equal(result.conflicts, 1);
assert.equal(result.notes[0].note, original.note);
assert.equal(result.notes[1].orphaned, true);
assert.equal(notes.merge(result.notes, [changed], 'alpha beta', true).added, 0);
assert.equal(notes.merge([], [original], 'alpha beta', false).notes[0].orphaned, true);
const second = { ...original, id: 'two', start: 6, end: 10, quote: 'beta' };
result = notes.merge([{ ...original, global: true }], [second], 'alpha beta alpha', true);
assert.equal(result.notes[1].orphaned, false, 'Unrelated global notes must not detach an import');
assert.throws(() => notes.parseBackup(JSON.stringify({ format: 'other', notes: [original] })));
assert.throws(() => notes.parseBackup(notes.backup(document, [{ ...original, note: '' }])));
assert.match(notes.markdown('文档', detached), /待定位/);
assert.match(notes.markdown('文档', detached), /保留说明/);
const pageNote = { ...original, id: 'pdf-page', type: 'pdf-page', pageNumber: 2,
  start: 0, end: 1, quote: '第 2 页（整页批注）' };
const pdf = { ...document, title: '扫描件.pdf', format: 'PDF' };
assert.equal(notes.normalize([pageNote], '', 3)[0].orphaned, false, 'Scanned pages need no text anchor');
assert.equal(notes.normalize([pageNote], '', 1)[0].orphaned, true, 'Missing PDF pages must remain detached');
assert.equal(notes.normalize([pageNote], 'plain text')[0].orphaned, true, 'PDF notes imported into text must not attach');
const restoredPage = notes.parseBackup(notes.backup(pdf, [pageNote])).notes[0];
assert.equal(restoredPage.type, 'pdf-page');
assert.equal(restoredPage.pageNumber, 2);
result = notes.merge([original], [restoredPage], 'alpha beta', true, 3);
assert.equal(result.notes[1].orphaned, false, 'Page notes do not overlap text highlights');
assert.equal(notes.merge(result.notes, [restoredPage], 'alpha beta', true, 3).skipped, 1);
assert.equal(notes.merge([], [restoredPage], '', false, 3).notes[0].orphaned, true, 'Different PDF source requires manual binding');
assert.match(notes.markdown('扫描件', [pageNote]), /位置：第 2 页/);
for (const pageNumber of [0, -1, 1.5, 501, '2']) {
  assert.throws(() => notes.parseBackup(notes.backup(pdf, [{ ...pageNote, pageNumber }])));
}
console.log('ReaderNotesCheck OK: text/PDF anchors, scan pages, round trip, deduplication, conflicts and validation');
