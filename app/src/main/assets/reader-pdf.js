/* Local PDF rendering. All document text stays in DOM order for shared note offsets. */
(function(root) {
  'use strict';
  let library;
  const assets = new URL('vendor/pdfjs/', document.baseURI).href;
  const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));

  class PdfDocument {
    constructor(container, scroller, onError, onOpenAnnotation) {
      this.container = container;
      this.scroller = scroller;
      this.onError = onError;
      this.onOpenAnnotation = onOpenAnnotation;
      this.pages = [];
      this.embeddedNotes = [];
      this.closed = false;
      this.queue = Promise.resolve();
      this.nearby = new Set();
    }

    async open(data, onProgress) {
      library ||= import('./vendor/pdfjs/pdf.min.mjs');
      const pdfjs = await library;
      if (this.closed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.min.mjs`;
      this.task = pdfjs.getDocument({ data, cMapUrl: `${assets}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`,
        isEvalSupported: false, enableXfa: false });
      const pdf = this.pdf = await this.task.promise;
      if (pdf.numPages > 500) throw new Error('当前最多打开 500 页的 PDF，请先拆分文件');
      const fragment = document.createDocumentFragment();
      let textLength = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        if (this.closed) return;
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: 600 / page.getViewport({ scale: 1 }).width });
        const content = await page.getTextContent();
        const annotations = await page.getAnnotations({ intent: 'display' });
        if (this.closed) return;
        const element = document.createElement('section');
        element.className = 'pdf-page';
        element.dataset.page = String(number);
        element.dataset.label = `第 ${number} 页`;
        element.setAttribute('aria-label', `第 ${number} 页`);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        element.style.setProperty('--total-scale-factor', viewport.scale);
        const canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        canvas.width = canvas.height = 0;
        const layer = document.createElement('div');
        layer.className = 'pdf-text-layer';
        element.append(canvas, layer);
        const textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
        this.textLayer = textLayer;
        await textLayer.render();
        this.textLayer = null;
        if (this.closed) return;
        // Explicit newlines keep quotes/offsets stable across lines and pages. Page
        // labels are CSS content, so they never contaminate the document text.
        layer.querySelectorAll('br').forEach(br => {
          const newline = document.createElement('span');
          newline.className = 'pdf-newline'; newline.textContent = '\n';
          br.replaceWith(newline);
        });
        const separator = document.createElement('span');
        separator.className = 'pdf-newline'; separator.textContent = '\n';
        element.append(separator);
        const text = element.textContent;
        this.addAnnotationTargets(element, annotations, viewport, number);
        if (textLength + text.length > 5_000_000) throw new Error('PDF 文字过多，请先拆分文件');
        this.pages.push({ number, page, viewport, element, canvas, start: textLength,
          end: textLength + text.length, text, rendered: false, renderTask: null });
        textLength += text.length;
        fragment.append(element);
        onProgress(number, pdf.numPages);
        await yieldFrame();
      }
      if (this.closed) return;
      this.container.replaceChildren(fragment);
      this.text = this.pages.map(page => page.text).join('');
      this.resize(1);
      this.observer = new IntersectionObserver(entries => {
        if (this.closed) return;
        for (const entry of entries) {
          const page = this.pages[Number(entry.target.dataset.page) - 1];
          if (entry.isIntersecting) this.nearby.add(page);
          else { this.nearby.delete(page); this.releaseCanvas(page); }
        }
        const center = this.scroller.getBoundingClientRect().top + this.scroller.clientHeight / 2;
        const nearest = [...this.nearby].sort((a, b) =>
          Math.abs(a.element.getBoundingClientRect().top - center)
          - Math.abs(b.element.getBoundingClientRect().top - center)).slice(0, 6);
        const retained = new Set(nearest);
        this.retained = retained;
        for (const page of this.pages) if (!retained.has(page)) this.releaseCanvas(page);
        for (const page of nearest) {
          this.queue = this.queue.then(async () => {
            if (this.closed || !this.retained.has(page) || page.rendered || page.renderTask) return;
            const scale = Math.min(2, Math.sqrt(4_000_000 / (page.viewport.width * page.viewport.height)));
            page.canvas.width = Math.ceil(page.viewport.width * scale);
            page.canvas.height = Math.ceil(page.viewport.height * scale);
            page.renderTask = page.page.render({ canvasContext: page.canvas.getContext('2d'),
              viewport: page.viewport, transform: [scale, 0, 0, scale, 0, 0] });
            try {
              await page.renderTask.promise;
              page.rendered = true;
            } catch (error) {
              if (!this.closed && error.name !== 'RenderingCancelledException') {
                page.element.dataset.label = `第 ${page.number} 页 · 显示失败`;
                this.onError(`第 ${page.number} 页显示失败，请重新打开 PDF`);
              }
            } finally {
              page.renderTask = null;
              if (this.closed || !this.retained.has(page)) this.releaseCanvas(page);
            }
          }).catch(error => { if (!this.closed) this.onError(error.message || 'PDF 页面显示失败'); });
        }
      }, { root: this.scroller, rootMargin: '400px' });
      this.pages.forEach(page => this.observer.observe(page.element));
    }

    addAnnotationTargets(element, annotations, viewport, pageNumber) {
      const targets = [];
      for (const annotation of annotations) {
        if (!['Text', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'FreeText', 'Ink', 'Stamp'].includes(annotation.subtype)
            || !annotation.contentsObj?.str) continue;
        const note = { pageNumber, contents: annotation.contentsObj.str,
          title: annotation.titleObj?.str || 'PDF 内批注' };
        this.embeddedNotes.push(note);
        if (annotation.noView || annotation.hidden) continue;
        const rectangles = [];
        const quads = annotation.quadPoints;
        if (quads?.length >= 8) {
          for (let index = 0; index + 7 < quads.length; index += 8) {
            const points = [];
            for (let offset = 0; offset < 8; offset += 2) {
              points.push(viewport.convertToViewportPoint(quads[index + offset], quads[index + offset + 1]));
            }
            rectangles.push([Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
              Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))]);
          }
        } else if (annotation.rect?.length === 4) {
          const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
          const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
          rectangles.push([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]);
        }
        const boxes = rectangles.filter(box => box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1]);
        if (!boxes.length) continue;
        targets.push({ note, boxes });
        // Empty controls keep document text/selection offsets unchanged. Pointer
        // hits on highlights are handled by the page so long-press selection works.
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'pdf-note-target';
        button.setAttribute('aria-label', `查看第 ${pageNumber} 页批注：${note.contents}`);
        button.title = '查看 PDF 内批注';
        if (annotation.subtype === 'Text') button.classList.add('pdf-note-icon');
        const [left, top, right, bottom] = boxes[0];
        Object.assign(button.style, { left: `${left}px`, top: `${top}px`,
          width: `${right - left}px`, height: `${bottom - top}px` });
        button.addEventListener('click', event => {
          event.stopPropagation();
          if (!this.closed) this.onOpenAnnotation?.(note);
        });
        element.append(button);
      }
      element.addEventListener('click', event => {
        if (this.closed || event.defaultPrevented || event.target.closest('mark.annotation')) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        const bounds = element.getBoundingClientRect();
        const x = (event.clientX - bounds.left) * viewport.width / bounds.width;
        const y = (event.clientY - bounds.top) * viewport.height / bounds.height;
        const target = targets.find(({ boxes }) => boxes.some(([left, top, right, bottom]) =>
          x >= left && x <= right && y >= top && y <= bottom));
        if (target) { event.stopPropagation(); this.onOpenAnnotation?.(target.note); }
      });
    }

    releaseCanvas(page) {
      page.renderTask?.cancel();
      page.rendered = false;
      if (!page.renderTask) {
        page.canvas.width = page.canvas.height = 0;
        page.page.cleanup();
      }
    }

    resize(zoom) {
      const width = Math.min(744, Math.max(200, this.scroller.clientWidth - 16));
      this.pages.forEach(page => { page.element.style.zoom = String(width / 600 * zoom); });
    }

    currentPage() {
      const top = this.scroller.getBoundingClientRect().top;
      return this.pages.find(page => page.element.getBoundingClientRect().bottom > top + 32)?.number || 1;
    }

    pageForOffset(offset) {
      return this.pages.find(page => offset >= page.start && offset < page.end)?.number || 1;
    }

    annotationSpecs(notes, rangesForNote) {
      if (this.closed) throw new Error('文档已关闭');
      if (notes.some(note => note.orphaned)) throw new Error('有待定位批注，请先重新定位后导出 PDF');
      const specs = [];
      const pageNoteCounts = new Map();
      for (const note of notes) {
        if (note.type === 'pdf-page') {
          const page = this.pages[note.pageNumber - 1];
          if (!page) throw new Error('整页批注对应的页面不存在');
          const index = pageNoteCounts.get(page.number) || 0;
          pageNoteCounts.set(page.number, index + 1);
          const size = 24 * page.viewport.scale;
          const columns = Math.max(1, Math.floor((page.viewport.width - 24) / (size + 6)));
          const x = Math.max(0, page.viewport.width - 12 - size - (index % columns) * (size + 6));
          const y = Math.min(page.viewport.height - size, 12 + Math.floor(index / columns) * (size + 6));
          const a = page.viewport.convertToPdfPoint(x, y), b = page.viewport.convertToPdfPoint(x + size, y + size);
          specs.push({ id: `${note.id}-p${page.number}`, pageNumber: page.number, type: 'text', contents: note.note,
            rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
          continue;
        }
        let found = false;
        const ranges = rangesForNote(note);
        for (const page of this.pages) {
          const intersections = ranges.filter(range => range.start < page.end && range.end > page.start);
          if (!intersections.length) continue;
          const bounds = page.element.getBoundingClientRect();
          const quads = [];
          const walker = document.createTreeWalker(page.element, NodeFilter.SHOW_TEXT);
          let offset = page.start;
          while (walker.nextNode()) {
            const node = walker.currentNode;
            for (const selection of intersections) {
              const start = Math.max(0, selection.start - offset), end = Math.min(node.length, selection.end - offset);
              if (end <= start || !node.data.slice(start, end).trim()) continue;
              const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
              for (const rect of range.getClientRects()) {
                if (rect.width < 0.01 || rect.height < 0.01) continue;
                const x1 = Math.max(0, rect.left - bounds.left) * page.viewport.width / bounds.width;
                const x2 = Math.min(bounds.width, rect.right - bounds.left) * page.viewport.width / bounds.width;
                const y1 = Math.max(0, rect.top - bounds.top) * page.viewport.height / bounds.height;
                const y2 = Math.min(bounds.height, rect.bottom - bounds.top) * page.viewport.height / bounds.height;
                const a = page.viewport.convertToPdfPoint(x1, y1), b = page.viewport.convertToPdfPoint(x2, y2);
                const left = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]);
                const bottom = Math.min(a[1], b[1]), top = Math.max(a[1], b[1]);
                if (right > left && top > bottom) quads.push([left, top, right, top, left, bottom, right, bottom]);
              }
            }
            offset += node.length;
          }
          if (quads.length) {
            const rect = [Infinity, Infinity, -Infinity, -Infinity];
            for (const quad of quads) {
              for (let index = 0; index < 8; index += 2) {
                rect[0] = Math.min(rect[0], quad[index]); rect[2] = Math.max(rect[2], quad[index]);
                rect[1] = Math.min(rect[1], quad[index + 1]); rect[3] = Math.max(rect[3], quad[index + 1]);
              }
            }
            specs.push({ id: `${note.id}-p${page.number}`, pageNumber: page.number, type: 'highlight',
              contents: note.note, quads, rect });
            found = true;
          }
        }
        if (!found) throw new Error('有文字批注无法定位，请重新打开文件后再导出');
      }
      return specs;
    }

    close() {
      this.closed = true;
      this.observer?.disconnect();
      this.textLayer?.cancel();
      this.pages.forEach(page => this.releaseCanvas(page));
      this.task?.destroy().catch(() => {});
      this.pages = [];
    }
  }

  root.ReaderPdf = { create: (container, scroller, onError, onOpenAnnotation) =>
    new PdfDocument(container, scroller, onError, onOpenAnnotation) };
})(globalThis);
