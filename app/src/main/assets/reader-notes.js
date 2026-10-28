/* Note data is shared by reading, editing and backup; no DOM or Android dependencies. */
(function(root) {
  'use strict';
  const MAX_NOTES = 5000;
  const newId = () => `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sameContent = (a, b) => a.quote === b.quote && a.note === b.note && a.global === b.global;

  function normalize(notes, text) {
    const ids = new Set();
    return (Array.isArray(notes) ? notes : []).filter(note => note && typeof note.note === 'string' && note.note.trim())
      .map(note => {
        let id = typeof note.id === 'string' ? note.id : '';
        if (!id || ids.has(id)) id = newId();
        ids.add(id);
        const validRange = Number.isInteger(note.start) && Number.isInteger(note.end)
          && note.start >= 0 && note.end > note.start && note.end <= text.length;
        const quote = typeof note.quote === 'string' ? note.quote
          : !note.orphaned && validRange ? text.slice(note.start, note.end) : '';
        return { ...note, id, quote,
          start: validRange ? note.start : 0, end: validRange ? note.end : Math.max(1, quote.length),
          global: Boolean(note.global),
          orphaned: Boolean(note.orphaned) || !validRange || !quote || text.slice(note.start, note.end) !== quote };
      });
  }

  function reanchor(notes, oldText, newText) {
    return normalize(notes, oldText).map(note => {
      if (note.orphaned || oldText === newText) return note;
      const first = newText.indexOf(note.quote);
      // Repeated quotations are ambiguous after an edit. Retain the note for manual binding.
      if (first < 0 || (!note.global && newText.indexOf(note.quote, first + 1) >= 0)) {
        return { ...note, orphaned: true };
      }
      return { ...note, start: first, end: first + note.quote.length, orphaned: false };
    });
  }

  function backup(document, notes) {
    return JSON.stringify({ format: 'lightreader-notes', version: 1, document,
      exportedAt: new Date().toISOString(), notes }, null, 2);
  }

  function parseBackup(raw) {
    if (typeof raw !== 'string' || raw.length > 2_000_000) throw new Error('笔记备份超过 2 MB 或内容无效');
    const data = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (data.format !== 'lightreader-notes' || data.version !== 1 || !data.document
        || typeof data.document.title !== 'string' || typeof data.document.textHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(data.document.textHash)
        || !Array.isArray(data.notes) || data.notes.length > MAX_NOTES) {
      throw new Error('不是支持的轻阅笔记备份（版本 1）');
    }
    data.notes = data.notes.map(note => {
      if (!note || typeof note.id !== 'string' || !note.id || note.id.length > 200
          || typeof note.note !== 'string' || !note.note.trim() || note.note.length > 2000
          || typeof note.quote !== 'string' || note.quote.length > 1_000_000
          || !Number.isInteger(note.start) || !Number.isInteger(note.end)
          || note.start < 0 || note.end <= note.start
          || typeof note.global !== 'boolean' || typeof note.orphaned !== 'boolean') {
        throw new Error('备份包含无效的批注，未导入任何内容');
      }
      // Only import note fields, never executable markup, provider settings or credentials.
      return { id: note.id, note: note.note, quote: note.quote, start: note.start, end: note.end,
        global: note.global, orphaned: note.orphaned,
        createdAt: Number.isFinite(note.createdAt) ? note.createdAt : 0,
        updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : 0,
        importedFromId: typeof note.importedFromId === 'string' ? note.importedFromId : undefined };
    });
    return data;
  }

  function merge(existing, incoming, text, sameDocument) {
    const notes = existing.map(note => ({ ...note }));
    let added = 0, skipped = 0, conflicts = 0;
    for (const original of incoming) {
      const identity = original.importedFromId || original.id;
      if (notes.some(note => (note.id === original.id || note.importedFromId === identity)
          && sameContent(note, original))) { skipped++; continue; }
      let note = normalize([{ ...original, orphaned: original.orphaned || !sameDocument }], text)[0];
      if (notes.some(item => item.id === note.id)) {
        note = { ...note, id: newId(), importedFromId: identity };
        conflicts++;
      }
      // Retain an overlapping import without disturbing the existing annotation.
      const ranges = item => {
        if (item.orphaned) return [];
        if (!item.global) return [{ start: item.start, end: item.end }];
        const found = [];
        if (!item.quote) return found;
        for (let at = text.indexOf(item.quote); at >= 0; at = text.indexOf(item.quote, at + item.quote.length)) {
          found.push({ start: at, end: at + item.quote.length });
        }
        return found;
      };
      const importedRanges = ranges(note);
      if (notes.some(item => ranges(item).some(a => importedRanges.some(b => a.start < b.end && b.start < a.end)))) {
        note.orphaned = true;
      }
      notes.push(note); added++;
    }
    if (notes.length > MAX_NOTES) throw new Error('合并后批注超过 5000 条，未导入');
    return { notes, added, skipped, conflicts, orphaned: notes.filter(note => note.orphaned).length };
  }

  function markdown(title, notes) {
    const escape = value => String(value).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
    const lines = [`# ${escape(title).replace(/\n/g, ' ')}`, '', `共 ${notes.length} 条批注`, ''];
    notes.forEach((note, index) => {
      lines.push(`## ${index + 1}${note.orphaned ? ' 待定位' : note.global ? ' 全局批注' : ''}`, '',
        ...String(note.quote || '原引用未保存').split('\n').map(line => `> ${escape(line)}`), '',
        escape(note.note), '', `位置：${note.orphaned ? '待重新定位' : `字符 ${note.start + 1}–${note.end}`}`);
      if (note.createdAt > 0) lines.push(`记录时间：${new Date(note.createdAt).toISOString()}`);
      lines.push('');
    });
    return lines.join('\n');
  }

  root.ReaderNotes = { normalize, reanchor, backup, parseBackup, merge, markdown };
  if (typeof module !== 'undefined') module.exports = root.ReaderNotes;
})(globalThis);
