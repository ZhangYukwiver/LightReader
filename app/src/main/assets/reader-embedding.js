(function(root) {
  'use strict';
  const MODEL = 'bge-small-zh-v1.5@75c43b069aac4d136ba6bc1122f995fedcfd2781:cls-window-mean-v1';
  const profile = () => root.ReaderWeb ? 'fp32' : 'q8';
  class Client {
    constructor(dtype = profile()) {
      this.profile = dtype; this.next = 0; this.pending = new Map();
      this.worker = new Worker(new URL('reader-embedding-worker.js', document.baseURI), { type: 'module' });
      this.worker.onmessage = event => {
        const message = event.data, request = this.pending.get(message.id); if (!request) return;
        if (message.progress) { request.progress?.(message.progress); return; }
        clearTimeout(request.timeout); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      };
      this.worker.onerror = () => this.close('本地模型加载失败，请检查模型资源或浏览器的 WebAssembly 支持');
    }
    request(type, text = '', query = false, progress) {
      if (!this.worker) return Promise.reject(new Error('本地模型已停止'));
      return new Promise((resolve, reject) => {
        const id = ++this.next;
        const timeout = setTimeout(() => this.close('本地模型加载或计算超时，可重试；已完成的进度会保留'), 180000);
        this.pending.set(id, { resolve, reject, progress, timeout });
        this.worker.postMessage({ id, type, text, query, profile: this.profile });
      });
    }
    init(progress) { return this.request('init', '', false, progress); }
    embed(text, query = false) { return this.request('embed', text, query); }
    close(message = '本地模型已暂停') {
      this.worker?.terminate(); this.worker = null;
      for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(new Error(message)); }
      this.pending.clear();
    }
  }
  root.ReaderEmbedding = { profile, signature: (dtype = profile()) => `${MODEL}:${dtype}`, create: dtype => new Client(dtype) };
})(window);
