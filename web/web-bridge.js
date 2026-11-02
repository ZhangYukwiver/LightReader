/* Synchronous reader bridge: document state in localStorage, source bytes in IndexedDB. */
(() => {
  'use strict';
  const PREFIX = 'lightreader-web-document:';
  const AI_KEY = 'lightreader-web-channels';
  const keys = new Map(), requests = new Set();
  let current = null, sequence = 0, exporting = null, database;
  const later = fn => setTimeout(fn, 0);
  const notify = message => later(() => showToast(message));
  function report(error) { notify(error?.name === 'QuotaExceededError' ? '浏览器存储空间不足。请先导出备份，再移除不需要的文档。' : error?.message || '操作失败，请重试'); }
  function read(id) {
    const value = localStorage.getItem(PREFIX + id);
    return value ? JSON.parse(value) : null;
  }
  function recent() {
    return Object.keys(localStorage).filter(key => key.startsWith(PREFIX)).map(key => JSON.parse(localStorage.getItem(key)))
      .map(record => ({ uri: record.id, name: record.name, format: record.format, noteCount: record.notes?.length || 0,
        modified: Boolean(record.draft), pinned: record.pinned, lastOpened: record.lastOpened }));
  }
  function refresh() { try { window.onRecentFiles?.(recent()); } catch (error) { report(error); } }
  function write(record, checkVersion = false) {
    if (checkVersion && read(record.id)?.revision !== record.revision) throw new Error('此文档已在其他标签页修改，请导出当前内容后重新打开');
    const next = { ...record, revision: (record.revision || 0) + 1 };
    localStorage.setItem(PREFIX + record.id, JSON.stringify(next));
    return next;
  }
  function patch(changes, token = current?.token) {
    if (!current || token !== current.token) return false;
    try { current.record = write({ ...current.record, ...changes }, true); return true; }
    catch (error) { report(error); return false; }
  }
  async function db() {
    database ||= new Promise((resolve, reject) => {
      let abandoned = false;
      const request = indexedDB.open('lightreader-web', 2);
      request.onupgradeneeded = () => {
        for (const name of ['files', 'knowledge']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onsuccess = () => {
        if (abandoned) { request.result.close(); return; }
        request.result.onversionchange = () => { request.result.close(); database = null; };
        resolve(request.result);
      };
      request.onerror = () => { database = null; reject(new Error('浏览器文件存储不可用，请允许本站保存本地数据')); };
      request.onblocked = () => { abandoned = true; database = null; reject(new Error('请关闭其他轻阅旧页面后重试，以升级本地知识库存储')); };
    });
    return database;
  }
  async function fileStore(method, id, bytes, storeName = 'files') {
    const connection = await db();
    return new Promise((resolve, reject) => {
      const tx = connection.transaction(storeName, method === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore(storeName);
      const request = method === 'put' ? store.put(bytes, id) : store[method](id);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('浏览器文件保存失败'));
    });
  }
  function decode(bytes) {
    let encoding = 'utf-8';
    if (bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le';
    else if (bytes[0] === 254 && bytes[1] === 255) encoding = 'utf-16be';
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n'); }
    catch { return new TextDecoder('gb18030').decode(bytes).replace(/\r\n?/g, '\n'); }
  }
  function maySwitch() {
    return !state.editing || confirm('当前 Word 修改尚未保存，继续将放弃这些修改。确定继续？');
  }
  async function activate(record, bytes, ticket) {
    // Adopt state saved while IndexedDB was reading the source bytes.
    record = read(record.id) || record;
    let parsed, text = '', html = '';
    if (record.format === 'DOCX') { parsed = ReaderWebDocx.open(bytes); text = parsed.text; html = parsed.html; }
    else if (record.format === 'TXT') text = decode(bytes);
    if (ticket !== sequence) return;
    if (record.draft) ({ text, html } = record.draft);
    record.textHash = record.format === 'PDF' ? record.id : sha256(text);
    record.lastOpened = Date.now();
    const conversation = record.conversation || { messages: [], pageMessages: [] };
    for (const list of [conversation.messages, conversation.pageMessages, [conversation.bookAnalysis?.pending].filter(Boolean)]) for (const message of list || []) {
      if (message.pending && !requests.has(message.id)) Object.assign(message, { pending: false, error: true, text: '上次请求已中断，请重新发送。' });
    }
    record.conversation = conversation;
    record = write(record, true);
    current = { record, bytes, parsed, text, html, token: crypto.randomUUID() };
    if (state.editing) { state.editing = false; doc.removeAttribute('contenteditable'); setEditingUi(false); }
    if (record.format === 'PDF') await beginPdfDocument(record.name, record.notes || [], record.progress || 0, current.token, bytes.length);
    else if (record.format === 'TXT' && text.length > 100000) beginTextDocument(record.name, record.notes || [], record.progress || 0, current.token, text.length);
    else loadDocument(record.name, text, record.notes || [], record.format, html, record.progress || 0, Boolean(record.draft), current.token);
    refresh();
  }
  async function importFile(file) {
    if (!file || !maySwitch()) return;
    flushReadingProgress();
    const ticket = ++sequence;
    try {
      const format = file.name.split('.').pop().toUpperCase();
      if (!['TXT', 'DOCX', 'PDF'].includes(format)) throw new Error('请选择 TXT、DOCX 或 PDF 文件');
      if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('文件为空或超过 20 MB');
      notify('正在打开文件…');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (ticket !== sequence) return;
      const id = sha256(bytes);
      const old = read(id);
      const record = old || { id, name: file.name, format, notes: [], progress: 0, revision: 0 };
      // Validate Word before persisting an unusable file.
      if (format === 'DOCX' && !old) ReaderWebDocx.open(bytes);
      await fileStore('put', id, bytes);
      if (ticket !== sequence) return;
      if (!old) localStorage.setItem(PREFIX + id, JSON.stringify(record));
      await activate(record, bytes, ticket);
    } catch (error) { report(error); }
  }
  function createPicker(accept, callback, id) {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    if (id) input.id = id;
    input.hidden = true; document.body.append(input);
    input.onchange = () => { const file = input.files[0]; input.value = ''; if (!id) input.remove(); if (file) Promise.resolve(callback(file)).catch(report); };
    input.oncancel = () => { if (!id) input.remove(); };
    return input;
  }
  const filePicker = createPicker('.txt,.docx,.pdf', importFile, 'web-file-input');
  function pick(accept, callback) { createPicker(accept, callback).click(); }
  function download(content, name, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.hidden = true;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const stem = () => current.record.name.replace(/\.[^.]+$/, '');
  function getAiState() {
    try {
      const saved = JSON.parse(localStorage.getItem(AI_KEY) || '{"channels":[],"selectedId":""}');
      return { ...saved, channels: saved.channels.map(channel => ({ ...channel, hasKey: Boolean(keys.get(channel.id)) })) };
    } catch (error) { report(error); return { channels: [], selectedId: '' }; }
  }
  function endpoint(channel) {
    const url = new URL(channel.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('API 地址必须为不含账号密码的 HTTPS 地址');
    const suffix = channel.protocol === 'responses' ? '/responses' : '/chat/completions';
    const path = url.pathname.replace(/\/+$/, '');
    if (!path) url.pathname = (url.hostname === 'api.deepseek.com' ? '' : '/v1') + suffix;
    else if (path === '/v1') url.pathname = path + suffix;
    return url.href;
  }
  async function sendAiRequest(raw) {
    const request = JSON.parse(raw), recordId = current?.record.id;
    const result = { id: request.id, documentToken: request.documentToken, ok: false };
    requests.add(request.id);
    try {
      const channel = getAiState().channels.find(item => item.id === request.channelId);
      if (!channel || !keys.get(channel.id)) throw new Error('请先填写当前渠道的 API Key（刷新后需重新填写）');
      if (request.webSearch && (channel.protocol !== 'responses' || !channel.webSearch)) throw new Error('当前渠道未启用联网搜索');
      const messages = [{ role: 'system', content: '你是轻阅中的阅读助手。先给结论，再给必要解释。不编造来源，以纯文本回答。' },
        ...(request.history || []).slice(-8).map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.text).slice(0, 6000) })),
        { role: 'user', content: String(request.prompt).slice(0, 12000) }];
      const body = channel.protocol === 'responses' ? { model: channel.model, input: messages.map(message => `${message.role}: ${message.content}`).join('\n\n') }
        : { model: channel.model, messages };
      if (request.webSearch) Object.assign(body, { tools: [{ type: 'web_search' }], tool_choice: 'required', include: ['web_search_call.action.sources'] });
      const response = await fetch(endpoint(channel), { method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keys.get(channel.id)}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
      if (!response.ok) throw new Error(`AI 请求失败（HTTP ${response.status}），请检查地址、模型与 Key`);
      const stream = response.body.getReader(), chunks = []; let size = 0;
      for (;;) { const { done, value } = await stream.read(); if (done) break; size += value.length;
        if (size > 5 * 1024 * 1024) { await stream.cancel(); throw new Error('AI 响应超过 5 MB'); } chunks.push(value); }
      const data = JSON.parse(await new Blob(chunks).text());
      const parts = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []);
      const content = data.choices?.[0]?.message?.content;
      result.text = data.output_text || parts.filter(part => part.type === 'output_text').map(part => part.text).join('\n')
        || (Array.isArray(content) ? content.map(part => part.text || '').join('\n') : content) || 'AI 没有返回文字结果。';
      result.citations = parts.flatMap(part => part.annotations || []).filter(item => item.url && /^https?:\/\//.test(item.url))
        .map(item => ({ url: item.url, title: item.title || item.url }));
      result.ok = true;
    } catch (error) {
      result.error = error.name === 'TypeError' ? '网络连接失败或服务商未允许浏览器跨域访问（CORS），请使用支持网页调用的渠道。'
        : ['TimeoutError', 'AbortError'].includes(error.name) ? '请求超时，请重试' : error.message;
    } finally { requests.delete(request.id); }
    if (current?.token === request.documentToken || (!current && !request.documentToken)) window.onAiResult(result);
    else if (recordId) {
      try {
        const record = read(recordId); if (!record) return;
        for (const list of [record.conversation?.messages, record.conversation?.pageMessages, [record.conversation?.bookAnalysis?.pending].filter(Boolean)]) {
          const message = list?.find(item => item.id === request.id);
          if (message) Object.assign(message, { pending: false, error: !result.ok, text: result.ok ? result.text : result.error, citations: result.citations || [] });
        }
        const saved = write(record, true);
        // The same document may have been reopened under a new render token.
        if (current?.record.id === recordId) { current.record = saved; restoreConversation(); }
      } catch (error) { report(error); }
    }
  }
  window.ReaderWeb = { importFile, download };
  window.ReaderBridge = {
    getLegacyReaderSettings: () => '{}', setDarkMode() {},
    openTextFile: () => filePicker.click(),
    async openRecentFile(id) {
      if (!maySwitch()) return;
      flushReadingProgress();
      const ticket = ++sequence;
      try {
        const record = read(id), bytes = await fileStore('get', id);
        if (!record || !bytes) throw new Error('浏览器中的原文件已被清理，请重新导入');
        await activate(record, bytes, ticket);
      } catch (error) { report(error); }
    },
    getRecentFiles: () => later(refresh),
    setRecentFilePinned(id, pinned) {
      try { const record = read(id); if (record) { const saved = write({ ...record, pinned }, true); if (current?.record.id === id) current.record = saved; } refresh(); } catch (error) { report(error); }
    },
    async deleteRecentFile(id) {
      try { await fileStore('delete', id, undefined, 'knowledge'); await fileStore('delete', id); localStorage.removeItem(PREFIX + id); refresh(); } catch (error) { report(error); }
    },
    clearDocumentState() { current = null; exporting = null; sequence++; },
    getTextChunk: (token, start, length) => current?.token === token ? current.text.slice(start, start + length) : '',
    getPdfChunk(token, start, length) {
      if (token !== current?.token) return '';
      let binary = ''; const bytes = current.bytes.subarray(start, start + length);
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(binary);
    },
    getDocumentData(token) {
      if (token !== current?.token) return '{}';
      const record = current.record;
      return JSON.stringify({ document: { title: record.name, format: record.format, textHash: record.textHash }, conversation: record.conversation || {} });
    },
    saveReadingProgress(value) { patch({ progress: Math.max(0, Math.min(1, Number(value) || 0)) }); },
    saveAnnotations(raw) { const data = JSON.parse(raw); return patch({ notes: data.notes }, data.documentToken); },
    saveConversation(token, raw) { return patch({ conversation: JSON.parse(raw) }, token); },
    async getBookKnowledge(token) {
      if (token !== current?.token) return { ok: false, error: '文档已切换' };
      const id = current.record.id;
      try {
        const data = await fileStore('get', id, undefined, 'knowledge');
        return token === current?.token ? { ok: true, data: data || null } : { ok: false, error: '文档已切换' };
      } catch (error) { return { ok: false, error: error.message || '知识库读取失败，可重建' }; }
    },
    async saveBookKnowledge(token, raw) {
      if (token !== current?.token) return false;
      try {
        const record = current.record, data = JSON.parse(raw);
        if (data.source !== record.textHash || data.version !== 1 || data.method !== 'bm25'
            || read(record.id)?.revision !== record.revision) throw new Error('文档版本已变化，请重新打开后建库');
        if (new Blob([raw]).size > 64 * 1024 * 1024) throw new Error('知识库索引超过 64 MB');
        await fileStore('put', record.id, data, 'knowledge');
        return token === current?.token;
      } catch (error) { report(error); return false; }
    },
    saveEditedDocument(raw) {
      const data = JSON.parse(raw);
      if (!patch({ draft: { text: data.text, html: data.html }, textHash: sha256(data.text), notes: data.notes })) return false;
      current.text = data.text; current.html = data.html; return true;
    },
    exportDocument() {
      if (!current) return;
      try {
        const { record } = current;
        if (record.format === 'DOCX') {
          const bytes = !record.draft && !record.notes.length ? current.bytes : current.parsed.output(current.html, record.notes);
          download(bytes, stem() + '-副本.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        } else download(current.text + (record.notes.length ? '\n\n' + ReaderNotes.markdown(record.name, record.notes) : ''), stem() + '-副本.txt', 'text/plain;charset=utf-8');
      } catch (error) { report(error); }
    },
    exportNotes(token, format, content) { if (token === current?.token) download(content, stem() + '-笔记.' + format, format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8'); },
    importNotes(token) { pick('.json', async file => { if (file.size > 2000000) throw new Error('笔记备份超过 2 MB'); window.onNotesImport(token, await file.text()); }); },
    beginPdfExport(token, length) {
      if (token !== current?.token || length > 40 * 1024 * 1024) return false;
      exporting = { token, bytes: new Uint8Array(length), offset: 0 }; return true;
    },
    appendPdfExport(token, chunk) {
      if (token !== current?.token || token !== exporting?.token) return false;
      const bytes = Uint8Array.from(atob(chunk), char => char.charCodeAt(0));
      if (exporting.offset + bytes.length > exporting.bytes.length) return false;
      exporting.bytes.set(bytes, exporting.offset); exporting.offset += bytes.length; return true;
    },
    finishPdfExport(token) {
      if (token !== current?.token || token !== exporting?.token || exporting.offset !== exporting.bytes.length) return false;
      download(exporting.bytes, stem() + '-含批注.pdf', 'application/pdf'); exporting = null; return true;
    },
    cancelPdfExport() { exporting = null; },
    copyText(text) { navigator.clipboard.writeText(text).catch(() => notify('复制失败，请使用浏览器复制快捷键')); },
    openExternalUrl(url) { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); },
    getAiState() {
      if (window.onAiState) window.onAiState(getAiState());
      else later(() => window.onAiState?.(getAiState()));
    },
    saveAiState(raw) {
      try {
        const data = JSON.parse(raw);
        const channels = data.channels.map(channel => {
          if (channel.apiKey) keys.set(channel.id, channel.apiKey);
          const { apiKey, hasKey, ...publicFields } = channel; return publicFields;
        });
        localStorage.setItem(AI_KEY, JSON.stringify({ selectedId: data.selectedId, channels }));
        for (const id of keys.keys()) if (!channels.some(channel => channel.id === id)) keys.delete(id);
      } catch (error) { report(error); }
    },
    sendAiRequest
  };
  window.addEventListener('storage', event => { if (event.key?.startsWith(PREFIX)) refresh(); });
})();
