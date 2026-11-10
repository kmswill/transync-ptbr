'use strict';

(() => {
  const api = window.transyncAPI;
  const pipFeed = document.getElementById('pipFeed');
  const pipEmpty = document.getElementById('pipEmpty');
  const btnFontDec = document.getElementById('btnFontDec');
  const btnFontInc = document.getElementById('btnFontInc');
  const btnClosePip = document.getElementById('btnClosePip');

  let fontSize = 16;

  function applyFontSize() {
    document.documentElement.style.setProperty('--pip-font-size', `${fontSize}px`);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function upsertPipEntry(entry) {
    if (!entry || !entry.id) return;
    if (pipEmpty) pipEmpty.style.display = 'none';

    const domId = `pip_${entry.id}`;
    let el = document.getElementById(domId);
    if (!el) {
      el = document.createElement('div');
      el.id = domId;
      pipFeed.appendChild(el);
    }

    const srcClass = entry.source === 'mic' ? 'mic' : 'system';
    const badge = entry.source === 'mic' ? '🎙️ Você' : '🎧 Teams';

    el.className = `pip-item ${srcClass}`;
    el.innerHTML = `
      <div class="pip-orig">${badge} (${escapeHtml(entry.sourceLang)}): ${escapeHtml(entry.sourceText)}</div>
      <div class="pip-trans">🇧🇷/🇪🇸 ${escapeHtml(entry.translatedText)}</div>
    `;

    // Mantém apenas as últimas 4 legendas na tela flutuante para máxima legibilidade
    const items = pipFeed.querySelectorAll('.pip-item');
    if (items.length > 4) {
      for (let i = 0; i < items.length - 4; i++) {
        items[i].remove();
      }
    }
    pipFeed.scrollTop = pipFeed.scrollHeight;
  }

  btnFontDec.addEventListener('click', () => {
    fontSize = Math.max(12, fontSize - 2);
    applyFontSize();
  });

  btnFontInc.addEventListener('click', () => {
    fontSize = Math.min(28, fontSize + 2);
    applyFontSize();
  });

  btnClosePip.addEventListener('click', () => {
    api.togglePip(false);
  });

  api.onUtterance((entry) => {
    upsertPipEntry(entry);
  });

  api.onEntriesCleared(() => {
    pipFeed.querySelectorAll('.pip-item').forEach((el) => el.remove());
    if (pipEmpty) pipEmpty.style.display = 'block';
  });

  api.getState().then((state) => {
    if (Array.isArray(state.entries)) {
      state.entries.slice(-3).forEach((entry) => upsertPipEntry(entry));
    }
  });
})();
