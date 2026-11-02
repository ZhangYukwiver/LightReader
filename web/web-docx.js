/* Browser adapter for WordprocessingML. Unknown, unchanged XML is kept in the package. */
(() => {
  'use strict';
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const children = (node, name) => [...node.children].filter(item => item.namespaceURI === W && (!name || item.localName === name));
  const child = (node, name) => children(node, name)[0];
  const attr = (node, name = 'val') => node?.getAttributeNS(W, name) || '';
  const prop = (node, name) => attr(child(node, name));
  const color = value => /^[0-9a-f]{6}$/i.test(value) ? '#' + value : '';
  const enabled = node => node && !['0', 'false', 'off'].includes(attr(node));
  function xml(bytes) {
    const raw = fflate.strFromU8(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('不支持包含外部实体的 DOCX');
    const parsed = new DOMParser().parseFromString(raw, 'application/xml');
    if (parsed.getElementsByTagName('parsererror').length) throw new Error('DOCX XML 损坏');
    return parsed;
  }
  function open(bytes) {
    let total = 0, count = 0;
    const files = fflate.unzipSync(bytes, { filter(entry) {
      total += entry.originalSize;
      if (++count > 2500 || total > 64 * 1024 * 1024 || entry.originalSize > 20 * 1024 * 1024) throw new Error('DOCX 解压后过大');
      return true;
    } });
    if (!files['word/document.xml']) throw new Error('不是有效的 DOCX 文件');
    const source = xml(files['word/document.xml']);
    const body = source.getElementsByTagNameNS(W, 'body')[0];
    if (!body) throw new Error('DOCX 缺少正文');
    const nodes = new Map(), originals = new Map(), relationships = new Map(), styles = new Map();
    if (files['word/_rels/document.xml.rels']) {
      for (const rel of xml(files['word/_rels/document.xml.rels']).documentElement.children) {
        if (rel.getAttribute('TargetMode') === 'External') continue;
        const target = rel.getAttribute('Target') || '';
        const pathname = new URL(target, 'https://docx.invalid/word/document.xml').pathname.slice(1);
        relationships.set(rel.getAttribute('Id'), pathname);
      }
    }
    if (files['word/styles.xml']) {
      for (const style of xml(files['word/styles.xml']).getElementsByTagNameNS(W, 'style')) styles.set(attr(style, 'styleId'), style);
    }
    function remember(element, node) {
      const id = String(nodes.size);
      nodes.set(id, node); element.dataset.webNode = id;
      return element;
    }
    function runStyle(element, properties) {
      if (!properties) return;
      if (child(properties, 'b')) element.style.fontWeight = enabled(child(properties, 'b')) ? '700' : '400';
      if (child(properties, 'i')) element.style.fontStyle = enabled(child(properties, 'i')) ? 'italic' : 'normal';
      if (child(properties, 'u')) element.style.textDecoration = prop(properties, 'u') === 'none' ? 'none' : 'underline';
      if (enabled(child(properties, 'strike'))) element.style.textDecoration = 'line-through';
      if (color(prop(properties, 'color'))) element.style.color = color(prop(properties, 'color'));
      if (color(attr(child(properties, 'shd'), 'fill'))) element.style.backgroundColor = color(attr(child(properties, 'shd'), 'fill'));
      const size = Number(prop(properties, 'sz'));
      if (size > 0) element.style.fontSize = `${Math.min(96, size * 2 / 3)}px`;
      if (prop(properties, 'vertAlign') === 'superscript') element.style.verticalAlign = 'super';
      if (prop(properties, 'vertAlign') === 'subscript') element.style.verticalAlign = 'sub';
    }
    function paragraphStyle(element, properties) {
      if (!properties) return;
      const alignment = prop(properties, 'jc');
      if (['left', 'right', 'center', 'both'].includes(alignment)) element.style.textAlign = alignment === 'both' ? 'justify' : alignment;
      const shade = color(attr(child(properties, 'shd'), 'fill'));
      if (shade) element.style.backgroundColor = shade;
      for (const [name, css] of [['left', 'marginLeft'], ['right', 'marginRight']]) {
        const value = Number(attr(child(properties, 'ind'), name));
        if (value > 0) element.style[css] = `${Math.min(300, value / 15)}px`;
      }
    }
    function inline(parent, node) {
      for (const part of node.children) {
        if (part.namespaceURI === W && part.localName === 'r') {
          const span = document.createElement('span'); runStyle(span, child(part, 'rPr')); inline(span, part); parent.append(span);
        } else if (part.namespaceURI === W && part.localName === 't') parent.append(part.textContent);
        else if (part.namespaceURI === W && ['br', 'cr'].includes(part.localName)) parent.append('\n');
        else if (part.namespaceURI === W && part.localName === 'tab') parent.append('\t');
        else if (part.namespaceURI === W && part.localName === 'drawing') {
          const blip = [...part.getElementsByTagName('*')].find(item => item.localName === 'blip');
          const file = relationships.get(blip?.getAttributeNS(R, 'embed'));
          if (file && /\.(png|jpe?g|gif|webp)$/i.test(file) && files[file]) {
            const image = remember(document.createElement('img'), part);
            let binary = ''; for (let i = 0; i < files[file].length; i += 8192) binary += String.fromCharCode(...files[file].subarray(i, i + 8192));
            image.src = `data:image/${/\.jpe?g$/i.test(file) ? 'jpeg' : file.split('.').pop().toLowerCase()};base64,${btoa(binary)}`;
            image.alt = '文档插图'; image.style.maxWidth = '100%'; parent.append(image);
          } else parent.append('〔暂不支持显示的插图〕');
        } else if (part.namespaceURI === W && ['hyperlink', 'smartTag', 'sdt', 'sdtContent', 'ins'].includes(part.localName)) inline(parent, part);
      }
    }
    function block(node) {
      if (node.localName === 'p') {
        const element = remember(document.createElement('p'), node);
        element.className = 'docx-p';
        const properties = child(node, 'pPr');
        if (properties && child(properties, 'numPr')) element.classList.add('docx-list');
        const styleId = properties && prop(properties, 'pStyle');
        if (styleId) {
          element.dataset.style = styleId;
          const chain = []; let style = styles.get(styleId);
          while (style && chain.length < 12 && !chain.includes(style)) { chain.unshift(style); style = styles.get(prop(style, 'basedOn')); }
          for (const item of chain) { paragraphStyle(element, child(item, 'pPr')); runStyle(element, child(item, 'rPr')); }
          if (/heading[1-6]|标题[1-6]/i.test(styleId)) { element.style.fontWeight = '700'; element.style.fontSize ||= '24px'; }
        }
        paragraphStyle(element, properties); inline(element, node);
        return element;
      }
      if (node.localName === 'tbl') {
        const table = remember(document.createElement('table'), node);
        table.className = 'docx-table';
        for (const row of children(node, 'tr')) {
          const tr = remember(document.createElement('tr'), row);
          for (const cell of children(row, 'tc')) {
            const td = remember(document.createElement('td'), cell);
            const properties = child(cell, 'tcPr');
            const span = properties && Number(prop(properties, 'gridSpan'));
            if (span > 1 && span < 100) td.colSpan = span;
            const shade = properties && color(attr(child(properties, 'shd'), 'fill'));
            if (shade) td.style.backgroundColor = shade;
            for (const item of children(cell)) if (['p', 'tbl'].includes(item.localName)) td.append(block(item), '\n');
            tr.append(td);
          }
          table.append(tr);
        }
        return table;
      }
      return null;
    }
    const root = document.createElement('div');
    for (const node of children(body)) {
      if (['p', 'tbl'].includes(node.localName)) root.append(block(node), '\n');
      else if (node.localName !== 'sectPr') {
        const placeholder = remember(document.createElement('p'), node);
        placeholder.textContent = '〔此内容请在 Word 中查看，导出时保留〕'; placeholder.contentEditable = 'false'; root.append(placeholder, '\n');
      }
    }
    root.querySelectorAll('[data-web-node]').forEach(element => originals.set(element.dataset.webNode, element.outerHTML));
    if (root.innerHTML.length > 5 * 1024 * 1024) throw new Error('DOCX 显示内容超过 5 MB');
    function output(html, notes) {
      const copy = source.cloneNode(true), dest = copy.getElementsByTagNameNS(W, 'body')[0];
      const section = child(dest, 'sectPr')?.cloneNode(true);
      const make = (name, attributes = {}) => {
        const el = copy.createElementNS(W, 'w:' + name);
        for (const [key, value] of Object.entries(attributes)) el.setAttributeNS(W, 'w:' + key, String(value));
        return el;
      };
      const template = document.createElement('template'); template.innerHTML = html;
      function runs(parent, node, inherited = {}) {
        if (node.nodeType === Node.TEXT_NODE) {
          const run = make('r'), pr = make('rPr');
          if (inherited.bold) pr.append(make('b'));
          if (inherited.italic) pr.append(make('i'));
          if (inherited.underline) pr.append(make('u', { val: 'single' }));
          if (inherited.color) pr.append(make('color', { val: inherited.color }));
          if (inherited.size) pr.append(make('sz', { val: inherited.size }));
          if (pr.children.length) run.append(pr);
          const parts = node.textContent.split(/(\n|\t)/);
          for (const part of parts) {
            if (part === '\n') run.append(make('br'));
            else if (part === '\t') run.append(make('tab'));
            else if (part) { const t = make('t'); t.setAttribute('xml:space', 'preserve'); t.textContent = part; run.append(t); }
          }
          parent.append(run); return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.tagName === 'BR') { const r = make('r'); r.append(make('br')); parent.append(r); return; }
        if (node.tagName === 'IMG') {
          const original = nodes.get(node.dataset.webNode);
          if (original?.localName === 'drawing') { const r = make('r'); r.append(copy.importNode(original, true)); parent.append(r); }
          return;
        }
        const style = { ...inherited };
        if (node.style.fontWeight) style.bold = Number(node.style.fontWeight) >= 600 || node.style.fontWeight === 'bold';
        if (node.style.fontStyle) style.italic = node.style.fontStyle === 'italic';
        if (node.style.textDecoration) style.underline = node.style.textDecoration.includes('underline');
        if (node.style.fontSize) style.size = Math.round(parseFloat(node.style.fontSize) * 1.5);
        const rgb = node.style.color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
        if (rgb) style.color = rgb.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('');
        for (const c of node.childNodes) runs(parent, c, style);
      }
      function convert(element) {
        const original = nodes.get(element.dataset?.webNode);
        const unchanged = originals.get(element.dataset?.webNode) === element.outerHTML;
        if (original && unchanged) return copy.importNode(original, true);
        if (element.tagName === 'TABLE') {
          const table = make('tbl');
          if (original?.localName === 'tbl') for (const p of children(original)) if (['tblPr', 'tblGrid'].includes(p.localName)) table.append(copy.importNode(p, true));
          for (const row of element.rows) {
            const tr = make('tr');
            const origRow = nodes.get(row.dataset.webNode), rowProperties = origRow && child(origRow, 'trPr');
            if (rowProperties) tr.append(copy.importNode(rowProperties, true));
            for (const cell of row.cells) {
              const tc = make('tc'), origCell = nodes.get(cell.dataset.webNode), pr = origCell && child(origCell, 'tcPr');
              if (pr) tc.append(copy.importNode(pr, true));
              for (const c of cell.childNodes) if (c.nodeType === 1 || c.textContent.trim()) tc.append(convert(c));
              if (tc.lastChild?.localName !== 'p') tc.append(make('p'));
              tr.append(tc);
            }
            table.append(tr);
          }
          return table;
        }
        // Retain unsupported content without rewriting its internal XML.
        if (original && !['p', 'tc', 'tr'].includes(original.localName)) return copy.importNode(original, true);
        const p = make('p');
        const pr = original?.localName === 'p' && child(original, 'pPr');
        if (pr) p.append(copy.importNode(pr, true));
        runs(p, element); return p;
      }
      dest.replaceChildren();
      for (const el of template.content.childNodes) if (el.nodeType === 1 || el.textContent.trim()) dest.append(convert(el));
      if (notes.length) {
        const title = make('p'), run = make('r'); run.append(make('br', { type: 'page' })); title.append(run); dest.append(title);
        for (const text of ['轻阅批注', ...notes.flatMap((note, i) => [`${i + 1}. ${note.orphaned ? '〔待定位〕' : ''}${note.quote}`, note.note])]) {
          const p = make('p'); runs(p, document.createTextNode(text)); dest.append(p);
        }
      }
      if (section) dest.append(section);
      const outputFiles = { ...files, 'word/document.xml': fflate.strToU8(new XMLSerializer().serializeToString(copy)) };
      return fflate.zipSync(outputFiles, { level: 6 });
    }
    return { html: root.innerHTML, text: root.textContent, output };
  }
  window.ReaderWebDocx = { open };
})();
