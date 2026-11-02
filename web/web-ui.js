document.addEventListener('DOMContentLoaded', () => {
  'use strict';
  const book = '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 8C12 5 7 5 3 6v19c4-1 9-1 13 2 4-3 9-3 13-2V6c-4-1-9-1-13 2Zm0 0v19" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  document.body.classList.add('web-app');
  const sidebar = document.createElement('aside'); sidebar.className = 'web-sidebar'; sidebar.setAttribute('aria-label', '主导航');
  sidebar.innerHTML = `<a class="web-brand" href="#" aria-label="轻阅书架"><span>${book}</span><div>轻阅<small>LIGHTREADER</small></div></a>
    <button class="web-import" type="button"><span>＋</span> 导入文件 <kbd>⌘ O</kbd></button>
    <nav><button class="web-library active" type="button"><span>▤</span> 我的书架 <small id="webFileCount">0</small></button>
    <button class="web-ai" type="button"><span>✧</span> AI 阅读助手</button>
    <button class="web-preferences" type="button"><span>☷</span> 阅读偏好</button></nav>
    <div class="web-current" hidden><span>正在阅读</span><strong></strong><button type="button">查看目录 →</button></div>
    <div class="web-sidebar-bottom"><span class="web-local-dot"></span> 文件只留在本浏览器<p>专注于文字，也留住思考。</p><small>网页版 · 本地书架</small></div>`;
  document.body.prepend(sidebar);
  sidebar.querySelector('.web-brand').onclick = event => { event.preventDefault(); goHome(); };
  sidebar.querySelector('.web-import').onclick = openTextFile;
  sidebar.querySelector('.web-library').onclick = goHome;
  sidebar.querySelector('.web-ai').onclick = openAiPage;
  sidebar.querySelector('.web-preferences').onclick = () => openSheet('settingsSheet');
  sidebar.querySelector('.web-current button').onclick = openToc;
  const originalHome = renderHome;
  const originalDisplay = onDisplayButton;
  onDisplayButton = function() {
    if (state.format === 'TXT') return openSheet('settingsSheet');
    return originalDisplay();
  };
  const originalRecent = window.onRecentFiles;
  window.onRecentFiles = function(value) { originalRecent(value); updateChrome(); };
  renderHome = function() {
    originalHome();
    const view = doc.querySelector('.home-view');
    view.querySelector('h1').textContent = '我的书架';
    view.querySelector('.hint').textContent = '从上次停下的地方，继续读下去。';
    const hero = document.createElement('section'); hero.className = 'web-welcome';
    hero.innerHTML = `<div class="web-eyebrow">A LITTLE SPACE TO READ</div><h2>给阅读，留一点空间。</h2>
      <p>打开一份文档，划下值得记住的句子。<br>阅读、批注与思考，在这里安静发生。</p>
      <div class="web-formats"><span>TXT <i>纯粹文字</i></span><span>DOCX <i>边读边改</i></span><span>PDF <i>保留原貌</i></span></div>
      <div class="web-book-art" aria-hidden="true"><div class="web-book-back"></div><div class="web-book-front"><span>轻 阅</span><i>READ<br>AT YOUR<br>OWN PACE.</i>${book}</div></div>`;
    view.prepend(hero);
    const empty = view.querySelector('.home-empty');
    if (empty) {
      empty.innerHTML = `<div class="web-empty-icon">${book}</div><strong>你的下一次阅读，从这里开始</strong><span>拖入文件，或从电脑中选择 · 单个文件不超过 20 MB</span><button type="button">＋ 选择文档</button><small>文件和批注保存在当前浏览器，清除网站数据前请先导出。</small>`;
      empty.querySelector('button').onclick = openTextFile;
    }
    for (const item of view.querySelectorAll('.recent-item')) {
      const label = item.querySelector('.recent-name').textContent;
      const file = [...state.recentFiles].sort(compareRecentFiles)[[...view.querySelectorAll('.recent-item')].indexOf(item)];
      const row = document.createElement('div'); row.className = 'web-recent-row';
      item.replaceWith(row); row.append(item);
      const menu = document.createElement('button'); menu.className = 'web-file-menu'; menu.textContent = '•••'; menu.type = 'button';
      menu.setAttribute('aria-label', `管理 ${label}`); menu.onclick = () => openRecentActions(file); row.append(menu);
    }
    updateChrome();
  };
  function updateChrome() {
    document.body.classList.toggle('web-home', !state.title);
    document.getElementById('webFileCount').textContent = String(state.recentFiles.length);
    const active = sidebar.querySelector('.web-current'); active.hidden = !state.title;
    active.querySelector('strong').textContent = state.title;
    active.querySelector('button').hidden = state.format !== 'PDF' && !state.chapters.length;
    sidebar.querySelector('.web-library').classList.toggle('active', !state.title);
    if (state.format === 'TXT') {
      document.getElementById('displayButton').textContent = '显示';
      document.getElementById('displayButton').setAttribute('aria-label', '显示设置');
    }
  }
  new MutationObserver(updateChrome).observe(doc, { attributes: true, attributeFilter: ['class'] });
  if (!state.title) renderHome();
  const drop = document.createElement('div'); drop.className = 'web-drop'; drop.hidden = true;
  drop.innerHTML = `${book}<strong>松开，开始阅读</strong><span>TXT / DOCX / PDF</span>`; document.body.append(drop);
  let dragDepth = 0;
  document.addEventListener('dragenter', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); dragDepth++; drop.hidden = false; } });
  document.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
  document.addEventListener('drop', event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); dragDepth = 0; drop.hidden = true;
    if (event.dataTransfer.files.length > 1) showToast('每次打开一份文档，已选择第一个文件');
    ReaderWeb.importFile(event.dataTransfer.files[0]);
  });
  // Paste as text so arbitrary clipboard HTML cannot become a persistent document script.
  doc.addEventListener('paste', event => {
    if (!state.editing) return;
    event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  });
  doc.addEventListener('drop', event => { if (state.editing) event.preventDefault(); });
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); openTextFile(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && state.title) { event.preventDefault(); toggleSearch(true); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.editing) { event.preventDefault(); saveEdit(); }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!window.handleNativeBack() && state.title) goHome();
    }
  });
  window.addEventListener('beforeunload', event => {
    flushReadingProgress();
    if (state.editing) { event.preventDefault(); event.returnValue = ''; }
  });
  if (!navigator.platform.includes('Mac')) sidebar.querySelector('kbd').textContent = 'Ctrl O';
});
