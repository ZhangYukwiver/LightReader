// Playwright CLI run-code snippet. Serve repository root on localhost:8765 and run
// create-pdf-fixture.py first. Only the native bridge is simulated; PDF parsing,
// workers, text layers, canvases and reader UI use the production assets.
async (page) => {
  await page.goto('http://127.0.0.1:8765/app/src/main/assets/reader.html');
  await page.setViewportSize({ width: 412, height: 915 });
  const result = await page.evaluate(async () => {
    const checks = [];
    const check = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 40));
    const bytes = new Uint8Array(await (await fetch('/build/pdf-fixture.pdf')).arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    let saved = [], exports = [], failSave = false, input = bytes, pdfChunks = [], exportedPdf, expectedSize;
    window.ReaderBridge = {
      getPdfChunk: (token, start, length) => btoa(String.fromCharCode(...input.slice(start, start + length))),
      saveAnnotations: raw => { if (failSave) return false; saved = JSON.parse(raw).notes; return true; },
      getDocumentData: () => JSON.stringify({ document: { title: '批注验证.pdf', format: 'PDF', textHash: hash }, conversation: {} }),
      exportNotes: (token, format, content) => exports.push({ format, content }),
      exportDocument: () => exports.push({ format: 'original' }),
      beginPdfExport: (token, size) => { expectedSize = size; pdfChunks = []; return true; },
      appendPdfExport: (token, value) => { pdfChunks.push(Uint8Array.from(atob(value), char => char.charCodeAt(0))); return true; },
      finishPdfExport: () => {
        exportedPdf = new Uint8Array(expectedSize);
        let offset = 0;
        for (const chunk of pdfChunks) { exportedPdf.set(chunk, offset); offset += chunk.length; }
        if (offset !== expectedSize) throw new Error('truncated PDF transfer');
        exports.push({ format: 'annotated-pdf' }); return true;
      },
      cancelPdfExport: () => {},
      saveReadingProgress: () => {}, clearDocumentState: () => {}, getRecentFiles: () => {}
    };
    window.confirm = () => true;
    await beginPdfDocument('批注验证.pdf', [], 0, 'fixture-1', bytes.length);
    check(state.pdf?.pages.length === 4 && !state.loading, 'real PDF parsed with four pages');
    check(doc.textContent === state.text && state.text.includes('中文批注测试'), 'DOM offsets match extracted English/CJK text');
    check(!state.pdf.pages[1].text.trim(), 'image-only page has no fabricated text');
    check(getComputedStyle(state.pdf.pages[2].element.querySelector('.pdf-text-layer')).transform !== 'none', 'rotated text layer follows page rotation');

    const quote = 'Highlight this first line.\nContinue on the second line.';
    const start = state.text.indexOf(quote);
    check(start >= 0, 'multiline quote is available');
    getSelection().removeAllRanges();
    getSelection().addRange(documentTextRange(start, start + quote.length));
    await tick();
    check(state.selection?.quote === quote, 'native DOM selection maps to exact quote');
    newNote(); document.getElementById('noteText').value = '跨行文字批注'; saveNote();
    const textId = state.notes[0].id;
    check(saved.length === 1 && !saved[0].orphaned, 'text annotation is persisted');
    check([...doc.querySelectorAll('mark.annotation')].map(mark => mark.textContent).join('') === quote, 'highlight covers all selected lines');
    const markCount = doc.querySelectorAll('mark.annotation').length;
    renderDocument(); renderDocument();
    check(doc.querySelectorAll('mark.annotation').length === markCount && doc.textContent === state.text, 'redraw does not duplicate marks or alter offsets');

    state.pdf.pages[1].element.scrollIntoView({ behavior: 'instant', block: 'start' });
    await tick(); newPdfPageNote();
    check(state.draftSelection.pageNumber === 2, 'page annotation targets visible scanned page');
    document.getElementById('noteText').value = '扫描页说明'; saveNote();
    const pageId = state.notes[1].id;
    check(saved.length === 2 && saved[1].type === 'pdf-page' && annotationCount() === 2, 'page and text annotations coexist');
    editNote(pageId); document.getElementById('noteText').value = '不应保存'; failSave = true; saveNote();
    check(state.notes.find(note => note.id === pageId).note === '扫描页说明', 'failed persistence rolls back the edit');
    failSave = false; editNote(pageId); document.getElementById('noteText').value = '扫描页说明已编辑'; saveNote();
    check(saved.find(note => note.id === pageId).note === '扫描页说明已编辑', 'page annotation can be edited');

    exportNotes('json'); exportNotes('md'); await exportDocument();
    check(exports[0].format === 'json' && exports[1].content.includes('第 2 页') && exports[2].format === 'annotated-pdf', 'JSON/Markdown and annotated PDF export paths work');
    const backup = exports[0].content;
    onNotesImport('stale-token', 'invalid');
    check(state.notes.length === 2, 'stale document imports are ignored');
    state.notes = []; persistNotes(); onNotesImport(state.documentToken, backup);
    check(state.notes.length === 2 && state.notes.every(note => !note.orphaned), 'JSON restores text and scanned-page annotations');
    onNotesImport(state.documentToken, backup);
    check(state.notes.length === 2, 'repeated import is deduplicated');
    closeSheet('notesSheet');

    const reopened = JSON.parse(JSON.stringify(saved));
    goHome(); await beginPdfDocument('批注验证.pdf', reopened, 0, 'fixture-2', bytes.length);
    check(state.notes.length === 2 && doc.querySelectorAll('mark.annotation').length === markCount, 'reopening restores persisted highlights');
    check(state.pdf.pages[1].element.dataset.pageNotes === '1', 'reopening restores page annotation indicator');
    adjustDocZoom(.5);
    check(state.docZoom === 1.5 && doc.textContent === state.text, 'zoom preserves annotation offsets');
    resetDocZoom();
    jumpToNote(pageId); await new Promise(resolve => setTimeout(resolve, 600));
    check(state.pdf.currentPage() === 2, 'note list jumps to scanned page');
    deleteNoteRecord(textId); deleteNoteRecord(pageId);
    check(!state.notes.length && !doc.querySelector('mark.annotation') && saved.length === 0, 'deletion removes highlights and persists');

    const loading = beginPdfDocument('取消导入.pdf', [], 0, 'cancelled', bytes.length);
    goHome(); await loading;
    check(state.title === '' && state.pdf === null, 'leaving while loading cannot resurrect PDF');
    input = new TextEncoder().encode('not a PDF');
    await beginPdfDocument('损坏.pdf', [], 0, 'invalid', input.length);
    check(state.pdf === null && document.getElementById('exportButton').disabled && doc.textContent.includes('无效'), 'corrupt PDF fails visibly without enabling annotation/export');
    loadDocument('回归.txt', 'alpha beta', [], 'TXT', null, 0, false, 'txt');
    check(doc.textContent === 'alpha beta' && state.format === 'TXT' && !doc.classList.contains('pdf'), 'TXT still loads after PDF errors');
    loadDocument('回归.docx', 'Word text', [], 'DOCX', '<p class="docx-p">Word text</p>', 0, false, 'word');
    check(doc.textContent === 'Word text' && doc.classList.contains('docx'), 'DOCX still loads after PDF');
    input = bytes;
    await beginPdfDocument('批注验证.pdf', reopened, 0, 'final', bytes.length);
    const pdfjs = await import('/app/src/main/assets/vendor/pdfjs/pdf.min.mjs');
    const inspectTask = pdfjs.getDocument({ data: exportedPdf.slice() });
    const inspect = await inspectTask.promise;
    const annotations = (await Promise.all([1, 2, 3, 4].map(async number => (await inspect.getPage(number)).getAnnotations()))).flat();
    check(inspect.numPages === 5 && annotations.some(note => note.subtype === 'Highlight' && note.contentsObj.str === '跨行文字批注'), 'export preserves original pages and appends a visible note page');
    check(annotations.some(note => note.subtype === 'Text' && note.contentsObj.str === '扫描页说明已编辑'), 'export embeds scanned-page note contents');
    check(annotations.filter(note => note.subtype !== 'Popup').every(note =>
      /^D:\d{14}Z$/.test(note.creationDate) && note.creationDate === note.modificationDate),
      'exported annotations have valid creation and modification dates');
    const visiblePage = await inspect.getPage(5);
    const operators = await visiblePage.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
    check(operators.fnArray.includes(pdfjs.OPS.paintImageXObject), 'note body is page content even with interactive annotations disabled');
    await inspectTask.destroy();
    check([...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('') === hash, 'PDF source bytes remain unchanged');
    input = exportedPdf;
    await beginPdfDocument('副本.pdf', [], 0, 'copy', exportedPdf.length);
    check(state.pdf.embeddedNotes.length === 2, 'exported PDF notes reopen without sidecar data');
    showNotes(); check(document.getElementById('notesList').textContent.includes('扫描页说明已编辑'), 'embedded Chinese notes appear in reader note list');
    closeSheet('notesSheet');
    await exportDocument();
    const againTask = pdfjs.getDocument({ data: exportedPdf.slice() });
    const again = await againTask.promise;
    const repeated = (await (await again.getPage(1)).getAnnotations()).filter(note => note.subtype === 'Highlight');
    check(repeated.length === 1 && again.numPages === 5, 're-export preserves annotations and visible pages without duplication');
    await againTask.destroy();
    const added = await ReaderPdfExport.write(exportedPdf, [{ id: 'new-visible-note', pageNumber: 2,
      type: 'text', rect: [40, 700, 64, 724], contents: '再次导出新增批注' }]);
    const addedTask = pdfjs.getDocument({ data: added });
    const addedPdf = await addedTask.promise;
    check(addedPdf.numPages === 6 && (await (await addedPdf.getPage(2)).getAnnotations())
      .some(note => note.contentsObj?.str === '再次导出新增批注'), 'new notes append visible content while preserving previous pages');
    await addedTask.destroy();
    const longNote = '超长批注：' + '中文内容与 English words、emoji 🙂 都必须完整换行。'.repeat(30)
      + '\n' + Array.from({ length: 65 }, (_, index) => `第 ${index + 1} 行：分页后继续显示完整批注。`).join('\n')
      + '\n结束标记：最后一句也必须显示。';
    const longBytes = await ReaderPdfExport.write(bytes, [{ id: 'long-visible-note', pageNumber: 4,
      type: 'text', rect: [40, 700, 64, 724], contents: longNote }]);
    const longTask = pdfjs.getDocument({ data: longBytes.slice() });
    const longPdf = await longTask.promise;
    check(longPdf.numPages >= 7 && (await (await longPdf.getPage(4)).getAnnotations())
      .some(note => note.contentsObj?.str === longNote), 'long Chinese multiline notes retain complete contents across summary pages');
    await longTask.destroy();
    window.pdfVisibleLongBytes = longBytes;
    input = await ReaderPdfExport.write(bytes, [
      { id: 'tap-multiline', pageNumber: 1, type: 'highlight', contents: '点击跨行高亮读取正文',
        rect: [48, 616, 360, 681], quads: [[48, 681, 280, 681, 48, 653, 280, 653],
          [48, 645, 360, 645, 48, 616, 360, 616]] },
      { id: 'tap-scanned', pageNumber: 2, type: 'text', contents: '点击扫描页便签读取正文', rect: [550, 750, 574, 774] },
      { id: 'tap-rotated', pageNumber: 3, type: 'highlight', contents: '点击旋转页高亮读取正文',
        rect: [48, 692, 310, 720], quads: [[48, 720, 310, 720, 48, 692, 310, 692]] }
    ]);
    await beginPdfDocument('点击批注.pdf', [], 0, 'tap-check', input.length);
    const tapPdfPoint = async (pageNumber, x, y) => {
      const pdfPage = state.pdf.pages[pageNumber - 1];
      pdfPage.element.scrollIntoView({ behavior: 'instant', block: 'start' });
      await tick();
      const [vx, vy] = pdfPage.viewport.convertToViewportPoint(x, y);
      const bounds = pdfPage.element.getBoundingClientRect();
      const clientX = bounds.left + vx * bounds.width / pdfPage.viewport.width;
      const clientY = bounds.top + vy * bounds.height / pdfPage.viewport.height;
      document.elementFromPoint(clientX, clientY).dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
      await tick();
    };
    const selectedNote = () => document.querySelector('#notesList .pdf-note-selected p')?.textContent;
    await tapPdfPoint(1, 100, 630);
    check(!document.getElementById('notesSheet').hidden && selectedNote() === '点击跨行高亮读取正文', 'tapping second highlight line opens its embedded note');
    closeSheet('notesSheet');
    await tapPdfPoint(1, 100, 649);
    check(document.getElementById('notesSheet').hidden, 'gap between highlight lines does not open a note');
    const selectedStart = state.text.indexOf('Highlight');
    getSelection().addRange(documentTextRange(selectedStart, selectedStart + 9));
    await tapPdfPoint(1, 100, 665);
    check(document.getElementById('notesSheet').hidden && getSelection().toString() === 'Highlight', 'highlight hit handling preserves text selection');
    getSelection().removeAllRanges();
    adjustDocZoom(.5);
    await tapPdfPoint(1, 100, 665);
    check(selectedNote() === '点击跨行高亮读取正文' && !document.getElementById('notesSheet').hidden, 'highlight taps track zoomed page coordinates');
    closeSheet('notesSheet'); resetDocZoom();
    await tapPdfPoint(3, 100, 706);
    check(selectedNote() === '点击旋转页高亮读取正文', 'highlight taps track rotated page coordinates');
    closeSheet('notesSheet');
    await tapPdfPoint(2, 562, 762);
    check(selectedNote() === '点击扫描页便签读取正文', 'scanned-page note icon opens embedded contents');
    closeSheet('notesSheet');
    state.pdf.pages[0].element.querySelector('.pdf-note-target').click();
    check(selectedNote() === '点击跨行高亮读取正文' && doc.textContent === state.text, 'keyboard-accessible note control preserves document offsets');
    closeSheet('notesSheet');
    input = exportedPdf;
    await beginPdfDocument('副本.pdf', [], 0, 'final-copy', input.length);
    return { passed: checks.length, checks };
  });
  await page.waitForFunction(() => state.pdf.pages[0].rendered);
  await page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'));
  await page.screenshot({ path: 'output/playwright/pdf-annotations/verified-mobile.png' });
  await page.evaluate(() => state.pdf.pages.at(-1).element.scrollIntoView({ behavior: 'instant' }));
  await page.waitForFunction(() => state.pdf.pages.at(-1).rendered);
  await page.screenshot({ path: 'output/playwright/pdf-annotations/visible-notes.png' });
  await page.evaluate(value => { window.pdfCheckResult = value; }, result);
  return result;
}
