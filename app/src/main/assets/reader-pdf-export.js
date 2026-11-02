/* PDF annotations and visible note pages in a copy; input bytes stay unchanged. */
(function(root) {
  'use strict';
  let library;
  const number = value => Number(value.toFixed(4));
  const VISIBLE_NOTE_KEY = 'LightReaderVisibleNote';
  const annotationTypes = new Set(['/Text', '/Highlight', '/Underline', '/StrikeOut', '/Squiggly', '/FreeText', '/Ink', '/Stamp']);

  async function appendVisibleNotes(output, pdfLib, sourceSize) {
    const { PDFName, PDFDict, PDFString, PDFHexString } = pdfLib;
    const context = output.context;
    const printedKey = PDFName.of(VISIBLE_NOTE_KEY);
    const notes = [];
    const readText = value => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
    for (const [index, page] of output.getPages().entries()) {
      const annotations = page.node.Annots();
      let ordinal = 0;
      for (const reference of annotations?.asArray() || []) {
        const annotation = context.lookup(reference);
        if (!(annotation instanceof PDFDict) || !annotationTypes.has(String(annotation.get(PDFName.of('Subtype'))))) continue;
        const contents = readText(context.lookup(annotation.get(PDFName.of('Contents'))));
        if (!contents.trim()) continue;
        ordinal++;
        // A printed body remains part of the document. On re-export, append only
        // new/changed bodies; never delete existing pages or third-party edits.
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${index + 1}\n${contents}`));
        const signature = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (readText(annotation.get(printedKey)) === signature) continue;
        notes.push({ annotation, signature, pageNumber: index + 1, ordinal, contents });
      }
    }
    if (!notes.length) return;

    const width = 595, height = 842, margin = 42, lineHeight = 22, bottom = height - 55;
    const canvas = document.createElement('canvas');
    canvas.width = width * 2; canvas.height = height * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法生成可见批注正文，请重试');
    let cursor = 0, sheet = 0, imageBytes = sourceSize;
    const setFont = (size, weight = '400') => { ctx.font = `${weight} ${size}px sans-serif`; };
    const startPage = () => {
      sheet++;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(2, 2); ctx.textBaseline = 'top';
      ctx.fillStyle = '#183c32'; setFont(24, '700'); ctx.fillText('批注正文', margin, 36);
      ctx.fillStyle = '#65736c'; setFont(11); ctx.fillText('对应原文页码见每条批注标题', margin, 73);
      ctx.strokeStyle = '#d8dfda'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(margin, 100); ctx.lineTo(width - margin, 100); ctx.stroke();
      cursor = 120;
    };
    const finishPage = async () => {
      if (output.getPageCount() >= 500) throw new Error('加入批注正文后超过 500 页，请先拆分 PDF');
      ctx.fillStyle = '#65736c'; setFont(10); ctx.fillText(`批注正文 · ${sheet}`, margin, height - 32);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      if (!blob) throw new Error('批注正文生成失败，请重试');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      imageBytes += bytes.length;
      if (imageBytes > 40 * 1024 * 1024) throw new Error('含批注 PDF 超过 40 MB，请先拆分文件');
      const image = await output.embedJpg(bytes);
      output.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    const heading = (note, continued = false) => {
      ctx.fillStyle = '#286c57'; setFont(12, '700');
      ctx.fillText(`第 ${note.pageNumber} 页 · 批注 ${note.ordinal}${continued ? '（续）' : ''}`, margin, cursor);
      cursor += 26;
      ctx.fillStyle = '#202623'; setFont(14);
    };
    const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    try {
      startPage();
      for (const note of notes) {
        if (cursor + 26 + lineHeight > bottom) { await finishPage(); startPage(); }
        heading(note);
        const drawLine = async text => {
          if (cursor + lineHeight > bottom) { await finishPage(); startPage(); heading(note, true); }
          ctx.fillText(text, margin, cursor); cursor += lineHeight;
        };
        for (const paragraph of note.contents.replace(/\r\n?/g, '\n').split('\n')) {
          let line = '';
          const graphemes = segmenter ? [...segmenter.segment(paragraph)].map(item => item.segment) : Array.from(paragraph);
          for (const character of graphemes) {
            if (line && ctx.measureText(line + character).width > width - margin * 2) {
              await drawLine(line); line = '';
            }
            line += character;
          }
          await drawLine(line);
        }
        cursor += 18;
      }
      await finishPage();
      notes.forEach(note => note.annotation.set(printedKey, PDFString.of(note.signature)));
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  async function write(source, annotations) {
    library ||= import('./vendor/pdf-lib/pdf-lib.min.mjs');
    const pdfLib = await library;
    const { PDFDocument, PDFName, PDFHexString, PDFString } = pdfLib;
    const output = await PDFDocument.load(source.slice(), { updateMetadata: false });
    const context = output.context;
    const pages = output.getPages();
    for (const annotation of annotations) {
      const page = pages[annotation.pageNumber - 1];
      if (!page || !annotation.contents || !annotation.rect.every(Number.isFinite)) throw new Error('批注位置无效，请重新打开 PDF');
      const rect = annotation.rect.map(number);
      const [left, bottom, right, top] = rect;
      if (right <= left || top <= bottom) throw new Error('批注范围无效，未导出');
      const width = right - left, height = top - bottom;
      const highlight = annotation.type === 'highlight';
      let commands;
      let resources = {};
      if (highlight) {
        if (!annotation.quads.length || annotation.quads.some(quad => quad.length !== 8 || !quad.every(Number.isFinite))) {
          throw new Error('高亮位置无效，未导出');
        }
        commands = ['q /GS0 gs 1 0.82 0 rg'];
        for (const quad of annotation.quads) {
          const point = index => `${number(quad[index] - left)} ${number(quad[index + 1] - bottom)}`;
          commands.push(`${point(0)} m ${point(2)} l ${point(6)} l ${point(4)} l h f`);
        }
        commands.push('Q');
        resources = { ExtGState: { GS0: { Type: 'ExtGState', ca: 0.35, CA: 0.35, BM: 'Multiply' } } };
      } else {
        // A printable note icon; the full Unicode body remains editable PDF text
        // in /Contents and is shown by the viewer's standard annotation popup.
        commands = [`q ${number(width / 24)} 0 0 ${number(height / 24)} 0 0 cm`,
          '1 0.88 0.35 rg 0.45 0.33 0 RG 1 w 2 2 20 20 re B',
          '0.45 0.33 0 RG 5 16 m 19 16 l 5 12 m 19 12 l 5 8 m 14 8 l S Q'];
      }
      const appearance = context.register(context.flateStream(commands.join('\n'), {
        Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, width, height], Resources: resources
      }));
      const date = PDFString.fromDate(new Date());
      const dictionary = context.obj({ Type: 'Annot', Subtype: highlight ? 'Highlight' : 'Text',
        P: page.ref, Rect: rect, F: 4, C: [1, 0.82, 0],
        Contents: PDFHexString.fromText(annotation.contents), T: PDFHexString.fromText('轻阅'),
        Subj: PDFHexString.fromText(highlight ? '文字批注' : '整页批注'),
        NM: PDFHexString.fromText(annotation.id), M: date, CreationDate: date,
        AP: { N: appearance }, ...(highlight ? { QuadPoints: annotation.quads.flat().map(number) } : { Name: 'Comment', Open: false })
      });
      const reference = context.register(dictionary);
      const popup = context.register(context.obj({ Type: 'Annot', Subtype: 'Popup', P: page.ref,
        Parent: reference, Rect: [right, bottom, right + 240, bottom + 140], Open: false }));
      dictionary.set(PDFName.of('Popup'), popup);
      // Append to /Annots directly: avoid normalizing/replacing original page content.
      let annots = page.node.Annots();
      if (!annots) { annots = context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
      annots.push(reference); annots.push(popup);
    }
    await appendVisibleNotes(output, pdfLib, source.length);
    return output.save({ useObjectStreams: false, updateFieldAppearances: false });
  }

  root.ReaderPdfExport = { write };
})(globalThis);
