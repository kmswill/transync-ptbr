'use strict';

(() => {
  const api = window.transyncAPI;

  // Elementos da UI
  const btnStartStop = document.getElementById('btnStartStop');
  const btnStartStopIcon = document.getElementById('btnStartStopIcon');
  const btnStartStopLabel = document.getElementById('btnStartStopLabel');
  const btnPause = document.getElementById('btnPause');
  const sessionTimer = document.getElementById('sessionTimer');
  const chkSystemAudio = document.getElementById('chkSystemAudio');
  const chkMicAudio = document.getElementById('chkMicAudio');
  const meterSystemFill = document.getElementById('meterSystemFill');
  const meterMicFill = document.getElementById('meterMicFill');

  const selTeamsLang = document.getElementById('selTeamsLang');
  const selMicLang = document.getElementById('selMicLang');
  const selWhisperModel = document.getElementById('selWhisperModel');

  const btnTogglePip = document.getElementById('btnTogglePip');
  const btnOpenGlossary = document.getElementById('btnOpenGlossary');
  const btnOpenSummary = document.getElementById('btnOpenSummary');
  const btnExport = document.getElementById('btnExport');
  const btnClear = document.getElementById('btnClear');

  const modelStatusDot = document.getElementById('modelStatusDot');
  const modelStatusText = document.getElementById('modelStatusText');
  const countBadge = document.getElementById('countBadge');

  const originalList = document.getElementById('originalList');
  const translationList = document.getElementById('translationList');
  const emptyStateOriginal = document.getElementById('emptyStateOriginal');
  const emptyStateTranslation = document.getElementById('emptyStateTranslation');

  const quickReplyInput = document.getElementById('quickReplyInput');
  const btnQuickTranslatePtToEs = document.getElementById('btnQuickTranslatePtToEs');
  const btnQuickTranslateEsToPt = document.getElementById('btnQuickTranslateEsToPt');
  const quickReplyOutput = document.getElementById('quickReplyOutput');
  const btnQuickSpeak = document.getElementById('btnQuickSpeak');
  const btnQuickCopy = document.getElementById('btnQuickCopy');

  // Modais
  const glossaryModal = document.getElementById('glossaryModal');
  const btnCloseGlossary = document.getElementById('btnCloseGlossary');
  const inpGlossarySource = document.getElementById('inpGlossarySource');
  const inpGlossaryTarget = document.getElementById('inpGlossaryTarget');
  const selGlossaryDir = document.getElementById('selGlossaryDir');
  const btnAddGlossary = document.getElementById('btnAddGlossary');
  const glossaryList = document.getElementById('glossaryList');
  const inpGroqKey = document.getElementById('inpGroqKey');
  const btnSaveGlossary = document.getElementById('btnSaveGlossary');

  const summaryModal = document.getElementById('summaryModal');
  const btnCloseSummary = document.getElementById('btnCloseSummary');
  const summaryTextarea = document.getElementById('summaryTextarea');
  const btnCopySummary = document.getElementById('btnCopySummary');
  const btnExportFromSummary = document.getElementById('btnExportFromSummary');

  // Estado local da sessão
  let isRunning = false;
  let isPaused = false;
  let timerInterval = null;
  let elapsedSeconds = 0;
  let currentGlossary = [];
  let utteranceCount = 0;
  let lastQuickTranslatedText = '';
  let lastQuickTranslatedLang = 'es';

  // Captura de microfone WebAudio + WebSpeech
  let micStream = null;
  let micAudioContext = null;
  let micProcessor = null;
  let webSpeechRecognizer = null;
  let webSpeechActive = false;

  function formatDuration(sec) {
    const hrs = String(Math.floor(sec / 3600)).padStart(2, '0');
    const mins = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const secs = String(sec % 60).padStart(2, '0');
    return `${hrs}:${mins}:${secs}`;
  }

  function startTimer() {
    stopTimer();
    elapsedSeconds = 0;
    sessionTimer.textContent = '00:00:00';
    timerInterval = setInterval(() => {
      if (!isPaused && isRunning) {
        elapsedSeconds += 1;
        sessionTimer.textContent = formatDuration(elapsedSeconds);
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function speakText(text, langCode) {
    if (!text || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = langCode === 'pt-BR' ? 'pt-BR' : 'es-MX';
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find((v) =>
      langCode === 'pt-BR'
        ? v.lang.toLowerCase().includes('pt-br')
        : v.lang.toLowerCase().startsWith('es')
    );
    if (preferred) utter.voice = preferred;
    window.speechSynthesis.speak(utter);
  }

  async function startMicrophoneCapture() {
    await stopMicrophoneCapture();
    if (!chkMicAudio.checked) return;

    // 1. Tenta WebSpeech API para baixa latência se disponível, mas mantém AudioContext p/ VU meter e fallback Whisper Local
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let useRawPcmForStt = true;

    if (SpeechRecognition) {
      try {
        const rec = new SpeechRecognition();
        const micLang = selMicLang.value === 'es' ? 'es-419' : 'pt-BR';
        rec.lang = micLang;
        rec.continuous = true;
        rec.interimResults = true;
        let currentWebSpeechId = `mic_ws_${Date.now()}`;

        rec.onstart = () => {
          webSpeechActive = true;
          useRawPcmForStt = false;
        };

        rec.onresult = (event) => {
          if (!isRunning || isPaused) return;
          let interimTranscript = '';
          let finalTranscript = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const res = event.results[i];
            if (res.isFinal) {
              finalTranscript += res[0].transcript;
            } else {
              interimTranscript += res[0].transcript;
            }
          }
          if (interimTranscript.trim()) {
            api.submitRecognizedText({
              utteranceId: currentWebSpeechId,
              source: 'mic',
              text: interimTranscript.trim(),
              isPartial: true
            });
          }
          if (finalTranscript.trim()) {
            const finishedId = currentWebSpeechId;
            currentWebSpeechId = `mic_ws_${Date.now()}`;
            api.submitRecognizedText({
              utteranceId: finishedId,
              source: 'mic',
              text: finalTranscript.trim(),
              isPartial: false
            });
          }
        };

        rec.onerror = () => {
          webSpeechActive = false;
          useRawPcmForStt = true;
        };

        rec.onend = () => {
          if (isRunning && !isPaused && chkMicAudio.checked && webSpeechActive) {
            try {
              rec.start();
            } catch {
              webSpeechActive = false;
              useRawPcmForStt = true;
            }
          }
        };

        rec.start();
        webSpeechRecognizer = rec;
      } catch {
        useRawPcmForStt = true;
      }
    }

    // 2. Captura WebAudio 16kHz para o medidor VU do microfone e fallback/Whisper Local
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });

      micAudioContext = new AudioContext({ sampleRate: 16000 });
      const sourceNode = micAudioContext.createMediaStreamSource(micStream);
      const processor = micAudioContext.createScriptProcessor(2048, 1, 1);

      processor.onaudioprocess = (event) => {
        if (!isRunning || isPaused || !chkMicAudio.checked) return;
        const input = event.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(input.length);
        let sumSq = 0;
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          int16[i] = s < 0 ? s * 32768 : s * 32767;
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / input.length);
        const level = Math.min(100, Math.round(rms * 320));
        meterMicFill.style.width = `${level}%`;

        // Se o WebSpeech não estiver ativo no Electron, envia o PCM 16kHz para o Whisper Local no Main Process
        if (useRawPcmForStt) {
          api.sendMicPcm(int16);
        }
      };

      sourceNode.connect(processor);
      processor.connect(micAudioContext.destination);
      micProcessor = processor;
    } catch (err) {
      console.warn('Aviso ao capturar microfone:', err);
    }
  }

  async function stopMicrophoneCapture() {
    webSpeechActive = false;
    if (webSpeechRecognizer) {
      try {
        webSpeechRecognizer.onend = null;
        webSpeechRecognizer.stop();
      } catch {}
      webSpeechRecognizer = null;
    }
    if (micProcessor) {
      try {
        micProcessor.disconnect();
      } catch {}
      micProcessor = null;
    }
    if (micAudioContext) {
      try {
        await micAudioContext.close();
      } catch {}
      micAudioContext = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    meterMicFill.style.width = '0%';
  }

  function renderUtterance(entry) {
    if (!entry || !entry.id) return;

    if (emptyStateOriginal) emptyStateOriginal.style.display = 'none';
    if (emptyStateTranslation) emptyStateTranslation.style.display = 'none';

    const origCardId = `orig_${entry.id}`;
    const transCardId = `trans_${entry.id}`;

    let origCard = document.getElementById(origCardId);
    let transCard = document.getElementById(transCardId);

    const isNew = !origCard;
    if (!origCard) {
      origCard = document.createElement('div');
      origCard.id = origCardId;
      originalList.appendChild(origCard);
    }
    if (!transCard) {
      transCard = document.createElement('div');
      transCard.id = transCardId;
      translationList.appendChild(transCard);
    }

    const sourceClass = entry.source === 'system' ? 'system' : 'mic';
    const partialClass = entry.isPartial ? 'partial' : '';
    const speakerIcon = entry.source === 'system' ? '🎧' : '🎙️';
    const sourceLangLabel = entry.sourceLang === 'pt-BR' ? '🇧🇷 PT-BR' : '🇪🇸 ES';
    const targetLangLabel = entry.targetLang === 'pt-BR' ? '🇧🇷 PT-BR (Brasil)' : '🇪🇸 ES (Espanhol)';

    origCard.className = `utterance-card ${sourceClass} ${partialClass}`;
    origCard.innerHTML = `
      <div class="utterance-meta">
        <span class="speaker-badge ${sourceClass}">${speakerIcon} ${escapeHtml(entry.speakerName)}</span>
        <div>
          <span class="lang-pill">${sourceLangLabel}</span>
          <span>${escapeHtml(entry.timestamp || '')}${entry.isPartial ? ' • ouvindo...' : ''}</span>
        </div>
      </div>
      <div class="utterance-text">${escapeHtml(entry.sourceText)}</div>
    `;

    const transColorClass = entry.targetLang === 'pt-BR' ? 'translated-ptbr' : 'translated-es';
    transCard.className = `utterance-card ${sourceClass} ${partialClass}`;
    transCard.innerHTML = `
      <div class="utterance-meta">
        <span class="speaker-badge ${sourceClass}">🌐 Tradução p/ ${targetLangLabel}</span>
        <span>${escapeHtml(entry.timestamp || '')}</span>
      </div>
      <div class="utterance-text ${transColorClass}">${escapeHtml(entry.translatedText)}</div>
      <div class="card-actions">
        <button class="card-action-btn btn-speak" title="Ouvir em voz alta">🔊 Ouvir</button>
        <button class="card-action-btn btn-copy" title="Copiar tradução">📋 Copiar</button>
      </div>
    `;

    const btnSpeak = transCard.querySelector('.btn-speak');
    const btnCopy = transCard.querySelector('.btn-copy');
    if (btnSpeak) {
      btnSpeak.onclick = () => speakText(entry.translatedText, entry.targetLang);
    }
    if (btnCopy) {
      btnCopy.onclick = () => {
        navigator.clipboard.writeText(entry.translatedText);
        btnCopy.textContent = '✓ Copiado!';
        setTimeout(() => {
          btnCopy.textContent = '📋 Copiar';
        }, 1200);
      };
    }

    if (isNew && !entry.isPartial) {
      utteranceCount += 1;
      countBadge.textContent = `${utteranceCount} intervenções`;
    } else if (!entry.isPartial) {
      const finalizedCards = originalList.querySelectorAll('.utterance-card:not(.partial)').length;
      utteranceCount = finalizedCards;
      countBadge.textContent = `${utteranceCount} intervenções`;
    }

    originalList.scrollTop = originalList.scrollHeight;
    translationList.scrollTop = translationList.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateControlsUI() {
    if (isRunning) {
      btnStartStop.classList.add('recording');
      btnStartStopIcon.textContent = '⏹';
      btnStartStopLabel.textContent = 'Parar Captura';
      btnPause.disabled = false;
      btnPause.textContent = isPaused ? '▶ Retomar' : '⏸ Pausar';
    } else {
      btnStartStop.classList.remove('recording');
      btnStartStopIcon.textContent = '▶';
      btnStartStopLabel.textContent = 'Iniciar Captura (Teams + Mic)';
      btnPause.disabled = true;
      btnPause.textContent = '⏸ Pausar';
      meterSystemFill.style.width = '0%';
      meterMicFill.style.width = '0%';
    }
  }

  function renderGlossaryList() {
    glossaryList.innerHTML = '';
    currentGlossary.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'glossary-item';
      row.innerHTML = `
        <span><strong>${escapeHtml(item.source)}</strong> → <strong style="color:#34d399">${escapeHtml(item.target)}</strong> <small>(${escapeHtml(item.direction || 'both')})</small></span>
        <button class="card-action-btn" data-idx="${index}">Remover</button>
      `;
      row.querySelector('button').onclick = () => {
        currentGlossary.splice(index, 1);
        renderGlossaryList();
      };
      glossaryList.appendChild(row);
    });
  }

  // Eventos de Botões
  btnStartStop.addEventListener('click', async () => {
    if (!isRunning) {
      const res = await api.startSession({
        captureSystemAudio: chkSystemAudio.checked,
        captureMicAudio: chkMicAudio.checked,
        teamsExpectedLang: selTeamsLang.value,
        micExpectedLang: selMicLang.value,
        whisperModel: selWhisperModel.value,
        groqFreeApiKey: inpGroqKey.value.trim()
      });
      if (res.ok) {
        isRunning = true;
        isPaused = false;
        startTimer();
        await startMicrophoneCapture();
        updateControlsUI();
      }
    } else {
      await stopMicrophoneCapture();
      await api.stopSession();
      isRunning = false;
      isPaused = false;
      stopTimer();
      updateControlsUI();
    }
  });

  btnPause.addEventListener('click', async () => {
    if (!isRunning) return;
    const res = await api.pauseSession(!isPaused);
    isPaused = Boolean(res.paused);
    updateControlsUI();
  });

  selTeamsLang.addEventListener('change', () => {
    api.updateConfig({ teamsExpectedLang: selTeamsLang.value });
  });

  selMicLang.addEventListener('change', () => {
    api.updateConfig({ micExpectedLang: selMicLang.value });
    if (isRunning && !isPaused) {
      startMicrophoneCapture();
    }
  });

  selWhisperModel.addEventListener('change', () => {
    api.updateConfig({ whisperModel: selWhisperModel.value });
  });

  btnTogglePip.addEventListener('click', async () => {
    const res = await api.togglePip();
    btnTogglePip.classList.toggle('active', Boolean(res.visible));
  });

  btnOpenGlossary.addEventListener('click', () => {
    renderGlossaryList();
    glossaryModal.classList.remove('hidden');
  });

  btnCloseGlossary.addEventListener('click', () => {
    glossaryModal.classList.add('hidden');
  });

  btnAddGlossary.addEventListener('click', () => {
    const src = inpGlossarySource.value.trim();
    const tgt = inpGlossaryTarget.value.trim();
    if (!src || !tgt) return;
    currentGlossary.push({
      source: src,
      target: tgt,
      direction: selGlossaryDir.value
    });
    inpGlossarySource.value = '';
    inpGlossaryTarget.value = '';
    renderGlossaryList();
  });

  btnSaveGlossary.addEventListener('click', async () => {
    await api.updateConfig({
      glossary: currentGlossary,
      groqFreeApiKey: inpGroqKey.value.trim()
    });
    glossaryModal.classList.add('hidden');
  });

  btnOpenSummary.addEventListener('click', async () => {
    const res = await api.generateSummary();
    summaryTextarea.value = res.markdown || '';
    summaryModal.classList.remove('hidden');
  });

  btnCloseSummary.addEventListener('click', () => {
    summaryModal.classList.add('hidden');
  });

  btnCopySummary.addEventListener('click', () => {
    navigator.clipboard.writeText(summaryTextarea.value);
    btnCopySummary.textContent = '✓ Ata Copiada!';
    setTimeout(() => {
      btnCopySummary.textContent = '📋 Copiar Ata';
    }, 1400);
  });

  btnExportFromSummary.addEventListener('click', async () => {
    await api.exportTranscript({ format: 'md' });
  });

  btnExport.addEventListener('click', async () => {
    await api.exportTranscript({ format: 'md' });
  });

  btnClear.addEventListener('click', async () => {
    await api.clearEntries();
  });

  async function triggerQuickTranslate(direction) {
    const text = quickReplyInput.value.trim();
    if (!text) return;
    quickReplyOutput.textContent = 'Traduzindo...';
    const res = await api.quickTranslate({ text, direction });
    lastQuickTranslatedText = res.translatedText || '';
    lastQuickTranslatedLang = res.targetLang || 'es';
    quickReplyOutput.textContent =
      lastQuickTranslatedText || 'Não foi possível traduzir.';
    btnQuickSpeak.disabled = !lastQuickTranslatedText;
    btnQuickCopy.disabled = !lastQuickTranslatedText;
  }

  btnQuickTranslatePtToEs.addEventListener('click', () =>
    triggerQuickTranslate('pt-BR->es')
  );
  btnQuickTranslateEsToPt.addEventListener('click', () =>
    triggerQuickTranslate('es->pt-BR')
  );
  quickReplyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      triggerQuickTranslate('pt-BR->es');
    }
  });
  btnQuickSpeak.addEventListener('click', () => {
    speakText(lastQuickTranslatedText, lastQuickTranslatedLang);
  });
  btnQuickCopy.addEventListener('click', () => {
    if (!lastQuickTranslatedText) return;
    navigator.clipboard.writeText(lastQuickTranslatedText);
  });
  quickReplyOutput.addEventListener('click', () => {
    if (!lastQuickTranslatedText) return;
    navigator.clipboard.writeText(lastQuickTranslatedText);
  });

  // Listeners IPC vindos do Main Process
  api.onUtterance((entry) => {
    renderUtterance(entry);
  });

  api.onAudioLevel(({ source, level }) => {
    if (source === 'system') {
      meterSystemFill.style.width = `${level}%`;
    } else if (source === 'mic') {
      meterMicFill.style.width = `${level}%`;
    }
  });

  api.onModelStatus((msg) => {
    if (!msg) return;
    if (msg.type === 'model-progress') {
      modelStatusDot.className = 'status-dot loading';
      modelStatusText.textContent = `Baixando modelo Whisper Local (${msg.file}): ${msg.progress}%`;
      return;
    }
    if (msg.status === 'loading') {
      modelStatusDot.className = 'status-dot loading';
      modelStatusText.textContent = msg.message || 'Carregando modelo...';
    } else if (msg.status === 'ready') {
      modelStatusDot.className = 'status-dot ready';
      modelStatusText.textContent = msg.message || 'Motor pronto';
    } else if (msg.status === 'error' || msg.status === 'warn') {
      modelStatusDot.className = 'status-dot error';
      modelStatusText.textContent = msg.message || 'Aviso no motor STT';
    }
  });

  api.onPipVisibility(({ visible }) => {
    btnTogglePip.classList.toggle('active', Boolean(visible));
  });

  api.onEntriesCleared(() => {
    originalList.querySelectorAll('.utterance-card').forEach((el) => el.remove());
    translationList.querySelectorAll('.utterance-card').forEach((el) => el.remove());
    if (emptyStateOriginal) emptyStateOriginal.style.display = 'block';
    if (emptyStateTranslation) emptyStateTranslation.style.display = 'block';
    utteranceCount = 0;
    countBadge.textContent = '0 intervenções';
  });

  // Inicialização
  api.getState().then((state) => {
    currentGlossary = state.glossary || [];
    selTeamsLang.value = state.teamsExpectedLang || 'es';
    selMicLang.value = state.micExpectedLang || 'pt-BR';
    selWhisperModel.value = state.whisperModel || 'Xenova/whisper-base';
    if (Array.isArray(state.entries)) {
      state.entries.forEach((entry) => renderUtterance(entry));
    }
  });
})();
