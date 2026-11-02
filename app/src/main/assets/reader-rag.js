/* Per-book sparse RAG index. Offsets refer to the owning document, never to AI-generated text. */
(function(root) {
  'use strict';
  const VERSION = 1, TOKENIZER = 'han-unigram-bigram-unicode-v2', SIZE = 1100, OVERLAP = 140;
  const STOP = new Set('的 是 在 了 吗 呢 和 与 及 有 我 你 它 这 那 一个 什么 如何 怎么 哪些 是否 可以 请问 这本 书中 中的 一下 the a an is are of to and or in on for with what how why'.split(' '));
  function tokens(value, query = false) {
    let normalized = String(value).normalize('NFKC').toLowerCase();
    if (query) normalized = normalized.replace(/是什么|什么是|有哪些|为什么|如何|怎么|请问|能否|这本书|书中|请解释|请介绍|请说明/g, ' ');
    const result = [];
    for (const word of normalized.match(/[\u3400-\u9fff]+|(?:(?![\u3400-\u9fff])[\p{L}\p{N}])+/gu) || []) {
      if (/^[\u3400-\u9fff]/.test(word)) {
        for (let i = 0; i < word.length; i++) {
          if (!STOP.has(word[i])) result.push(word[i]);
          if (i + 1 < word.length && !STOP.has(word.slice(i, i + 2))) result.push(word.slice(i, i + 2));
        }
      } else if (!STOP.has(word) && word.length < 100) result.push(word);
    }
    return result;
  }
  function slices(text, parents) {
    const chunks = [];
    parents.forEach((batch, index) => (batch.sections || [batch]).forEach(parent => {
      let start = parent.start;
      while (start < parent.end) {
        let end = Math.min(parent.end, start + SIZE);
        if (end < parent.end) {
          const part = text.slice(start, end), breaks = [...part.matchAll(/[\n。！？.!?]/g)];
          const boundary = breaks.at(-1)?.index;
          if (boundary >= SIZE * .6) end = start + boundary + 1;
          if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        }
        if (text.slice(start, end).trim()) chunks.push({ id: `K${String(chunks.length + 1).padStart(6, '0')}`,
          start, end, index, label: parent.label, length: 0 });
        if (end >= parent.end) break;
        start = end - OVERLAP;
        if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
      }
    }));
    return chunks;
  }
  async function build(text, job, options = {}) {
    const chunks = slices(text, job.chunks), postings = Object.create(null);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (options.cancelled?.()) throw new Error('知识库构建已取消');
      const chunk = chunks[i], frequencies = new Map();
      const words = tokens(text.slice(chunk.start, chunk.end) + '\n' + chunk.label);
      chunk.length = words.length; total += words.length;
      for (const word of words) frequencies.set(word, (frequencies.get(word) || 0) + 1);
      for (const [word, frequency] of frequencies) (postings[word] ||= []).push(i, frequency);
      if (i % 16 === 0) {
        options.progress?.(i + 1, chunks.length);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    options.progress?.(chunks.length, chunks.length);
    return { version: VERSION, method: 'bm25', tokenizer: TOKENIZER,
      source: job.source, textLength: text.length, analysisId: job.createdAt, title: job.title,
      builtAt: Date.now(), chunks, postings, averageLength: chunks.length ? total / chunks.length : 0 };
  }
  function matches(kb, job, textLength) {
    return kb?.version === VERSION && kb.method === 'bm25' && kb.tokenizer === TOKENIZER && kb.source === job.source
      && kb.textLength === textLength && kb.analysisId === job.createdAt && Array.isArray(kb.chunks)
      && kb.chunks.length > 0 && Number.isFinite(kb.averageLength) && kb.averageLength > 0
      && kb.postings && typeof kb.postings === 'object'
      && kb.chunks.every(c => Number.isInteger(c.start) && Number.isInteger(c.end) && c.start >= 0
        && c.end > c.start && c.end <= textLength && c.length >= 0 && /^K\d+$/.test(c.id));
  }
  function search(kb, query, limit = 4) {
    const terms = [...new Set(tokens(query, true))].slice(0, 256);
    const scores = new Map(), primary = new Set();
    // Standard BM25 term-frequency saturation and length normalization (k1=1.2, b=.75).
    // Positive IDF variant avoids discarding common terms in short books.
    for (const term of terms) {
      const entries = Object.prototype.hasOwnProperty.call(kb.postings, term) ? kb.postings[term] : null;
      if (!Array.isArray(entries)) continue;
      const idf = Math.log(1 + (kb.chunks.length - entries.length / 2 + .5) / (entries.length / 2 + .5));
      const singleHan = /^[\u3400-\u9fff]$/.test(term), weight = singleHan ? .18 : 1;
      for (let i = 0; i < entries.length; i += 2) {
        const index = entries[i], frequency = entries[i + 1], chunk = kb.chunks[index];
        if (!chunk || !(frequency > 0)) continue;
        const score = weight * idf * frequency * 2.2 / (frequency + 1.2 * (.25 + .75 * chunk.length / kb.averageLength));
        scores.set(index, (scores.get(index) || 0) + score);
        if (!singleHan) primary.add(index);
      }
    }
    const requirePrimary = terms.some(term => !/^[\u3400-\u9fff]$/.test(term));
    return [...scores].filter(([index, score]) => score > 0 && (!requirePrimary || primary.has(index)))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit)
      .map(([index, score]) => ({ ...kb.chunks[index], citation: kb.chunks[index].id, score }));
  }
  const vectorCache = new WeakMap();
  function packVector(vector) {
    if (vector.length !== 512 || !Array.from(vector).every(Number.isFinite)) throw new Error('语义向量格式无效');
    const bytes = new Uint8Array(2048), view = new DataView(bytes.buffer);
    vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
    return btoa(String.fromCharCode(...bytes));
  }
  function unpackVector(value) {
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    if (bytes.length !== 2048) throw new Error('已保存的语义向量长度不正确');
    const view = new DataView(bytes.buffer), vector = new Float32Array(512);
    for (let i = 0; i < 512; i++) vector[i] = view.getFloat32(i * 4, true);
    if (!Array.from(vector).every(Number.isFinite)) throw new Error('已保存的语义向量无效');
    return vector;
  }
  function semanticCompatible(kb, signature) {
    const semantic = kb?.semantic;
    return semantic?.version === 1 && semantic.signature === signature && semantic.dimension === 512
      && semantic.encoding === 'float32le-base64' && Array.isArray(semantic.vectors)
      && semantic.vectors.length <= kb.chunks.length && semantic.vectors.every(v => typeof v === 'string' && v.length === 2732);
  }
  function semanticReady(kb, signature) {
    return semanticCompatible(kb, signature) && kb.semantic.vectors.length === kb.chunks.length;
  }
  function semanticSearch(kb, vector, limit = 24) {
    if (!kb.semantic || kb.semantic.vectors.length !== kb.chunks.length || vector.length !== 512) return [];
    let cached = vectorCache.get(kb.semantic);
    if (!cached) { cached = kb.semantic.vectors.map(unpackVector); vectorCache.set(kb.semantic, cached); }
    return cached.map((item, index) => {
      let score = 0; for (let i = 0; i < 512; i++) score += item[i] * vector[i];
      return { ...kb.chunks[index], citation: kb.chunks[index].id, score };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  function hybridSearch(kb, query, vector, limit = 4) {
    const lexical = search(kb, query, 24);
    if (!vector) return lexical.slice(0, limit);
    // Identifiers containing digits need exact evidence, not approximate semantic neighbours.
    if (/^(?=.*[a-z])(?=.*\d)[a-z\d_-]+$/i.test(query.trim())) return lexical.slice(0, limit);
    const dense = semanticSearch(kb, vector).filter(hit => hit.score >= .4);
    const combined = new Map();
    for (const list of [lexical, dense]) list.forEach((hit, rank) => {
      const item = combined.get(hit.id) || { ...hit, score: 0 };
      item.score += 1 / (60 + rank + 1); combined.set(hit.id, item);
    });
    return [...combined.values()].sort((a, b) => b.score - a.score || a.start - b.start).slice(0, limit);
  }
  const api = { build, matches, search, tokens, slices, packVector, unpackVector, semanticCompatible, semanticReady, semanticSearch, hybridSearch };
  root.ReaderRag = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
