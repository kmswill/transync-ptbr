'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WindowsSystemAudioLoopback,
  WindowsPipZOrderHelper
} = require('./audio-loopback');
const { RealtimeVadSegmenter, int16ToFloat32 } = require('./vad-segmenter');
const {
  translateBidirectionalPtBrEs,
  DEFAULT_GLOSSARY
} = require('./translator');
const { HybridFreeSttEngine } = require('./stt-engine');
const { generateMeetingSummaryPtBr } = require('./meeting-summary');

let mainWindow = null;
let pipWindow = null;

const loopbackCapture = new WindowsSystemAudioLoopback();
const pipZOrderHelper = new WindowsPipZOrderHelper();
const sttEngine = new HybridFreeSttEngine({
  modelId: 'Xenova/whisper-tiny'
});

const systemVad = new RealtimeVadSegmenter({
  source: 'system',
  speechThresholdRms: 0.014,
  silenceHangoverMs: 450,
  softCutStartMs: 3200,
  softCutSilenceMs: 64,
  minSpeechMs: 380,
  maxSegmentMs: 8000,
  partialIntervalMs: 0
});

const micVad = new RealtimeVadSegmenter({
  source: 'mic',
  speechThresholdRms: 0.020,
  silenceHangoverMs: 450,
  softCutStartMs: 3200,
  softCutSilenceMs: 64,
  minSpeechMs: 420,
  maxSegmentMs: 8000,
  partialIntervalMs: 0
});

const appState = {
  running: false,
  paused: false,
  captureSystemAudio: true,
  captureMicAudio: true,
  engineMode: 'hybrid-free',
  whisperModel: 'Xenova/whisper-tiny',
  teamsExpectedLang: 'auto',
  micExpectedLang: 'pt-BR',
  contextNote: 'Reunião Microsoft Teams (Time Espanhol ⇄ Português do Brasil PT-BR)',
  glossary: [...DEFAULT_GLOSSARY],
  entries: [],
  pipVisible: false,
  pipOpacity: 92,
  pipFontSize: 16
};

// Controle anti-repetição (evita cartões duplicados ou eco do alto-falante no microfone)
const recentUtteranceFingerprints = [];
let lastSystemActiveAt = 0;

function normalizeFingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isDuplicateRecentUtterance(text) {
  const fp = normalizeFingerprint(text);
  if (!fp || fp.replace(/\s+/g, '').length < 3) return true;

  const now = Date.now();
  while (recentUtteranceFingerprints.length > 0 && now - recentUtteranceFingerprints[0].time > 12000) {
    recentUtteranceFingerprints.shift();
  }

  for (const item of recentUtteranceFingerprints) {
    if (item.fp === fp) {
      return true;
    }
    // Se uma frase curta inteira (>6 letras) já está contida literalmente na anterior recente (3.5s)
    if (
      now - item.time < 3500 &&
      fp.length >= 6 &&
      (item.fp.includes(fp) || fp.includes(item.fp)) &&
      Math.abs(item.fp.length - fp.length) <= 8
    ) {
      return true;
    }
  }

  recentUtteranceFingerprints.push({ fp, time: now });
  return false;
}

function broadcastToWindows(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
  if (pipWindow && !pipWindow.isDestroyed() && !pipWindow.webContents.isDestroyed()) {
    pipWindow.webContents.send(channel, payload);
  }
}

function formatNowTime() {
  return new Date().toLocaleTimeString('pt-BR', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

async function processRecognizedText({
  utteranceId,
  source,
  rawText,
  isPartial = false,
  bypassDedup = false
}) {
  const cleanText = String(rawText || '').trim();
  if (!cleanText) {
    return null;
  }

  if (!isPartial && !bypassDedup && isDuplicateRecentUtterance(cleanText)) {
    return null;
  }

  const expectedLang =
    source === 'system' ? appState.teamsExpectedLang : appState.micExpectedLang;

  const translation = await translateBidirectionalPtBrEs(cleanText, {
    sourceLangHint: expectedLang,
    forceSourceLang: expectedLang === 'auto' ? null : expectedLang,
    glossary: appState.glossary
  });

  if (!translation.translatedText) {
    return null;
  }

  const entry = {
    id: utteranceId || `${source}_${Date.now()}`,
    source,
    speakerName: source === 'system' ? 'Áudio do PC / Teams' : 'Você (Microfone)',
    timestamp: formatNowTime(),
    sourceText: translation.sourceText,
    translatedText: translation.translatedText,
    sourceLang: translation.sourceLang,
    targetLang: translation.targetLang,
    provider: translation.provider,
    isPartial: Boolean(isPartial)
  };

  if (!isPartial) {
    const existingIdx = appState.entries.findIndex((e) => e.id === entry.id);
    if (existingIdx >= 0) {
      appState.entries[existingIdx] = entry;
    } else {
      appState.entries.push(entry);
      if (appState.entries.length > 500) {
        appState.entries.shift();
      }
    }
  }

  broadcastToWindows('transync:utterance', entry);
  return entry;
}

function broadcastLiveStatus(status, message) {
  broadcastToWindows('transync:model-status', {
    type: 'model-status',
    status,
    message
  });
}

async function handleVadSegment(segment, isPartial) {
  if (!appState.running || appState.paused) return;

  const languageHint =
    segment.source === 'system'
      ? appState.teamsExpectedLang || 'auto'
      : appState.micExpectedLang || 'pt-BR';

  const sourceLabel = segment.source === 'system' ? 'Teams / PC' : 'Microfone';
  broadcastLiveStatus('loading', `⚡ Transcrevendo e traduzindo fala (${sourceLabel})...`);

  try {
    const text = await sttEngine.transcribeSegment({
      source: segment.source,
      int16Samples: segment.int16Samples,
      float32Samples: segment.float32Samples,
      languageHint,
      isPartial
    });

    if (text) {
      await processRecognizedText({
        utteranceId: segment.utteranceId,
        source: segment.source,
        rawText: text,
        isPartial
      });
    }

    if (!sttEngine.isBusy()) {
      broadcastLiveStatus(
        'ready',
        `✓ Escutando em tempo real (${appState.whisperModel} • Zero Tokens)`
      );
    }
  } catch (err) {
    broadcastLiveStatus('warn', `Aviso STT (${segment.source}): ${err.message}`);
  }
}

systemVad.on('level', (lvl) => {
  if (appState.running && !appState.paused) {
    if (lvl.rms >= 0.014) {
      lastSystemActiveAt = Date.now();
    }
    broadcastToWindows('transync:audio-level', lvl);
  }
});
systemVad.on('speech-start', () => {
  if (appState.running && !appState.paused) {
    broadcastLiveStatus('loading', '🎧 Captando fala no Áudio do PC / Teams...');
  }
});
systemVad.on('speech-cancel', () => {
  if (appState.running && !appState.paused && !sttEngine.isBusy()) {
    broadcastLiveStatus('ready', `✓ Escutando em tempo real (${appState.whisperModel} • Zero Tokens)`);
  }
});
systemVad.on('final', (seg) => handleVadSegment(seg, false));

micVad.on('level', (lvl) => {
  if (appState.running && !appState.paused) {
    broadcastToWindows('transync:audio-level', lvl);
  }
});
micVad.on('speech-start', () => {
  if (appState.running && !appState.paused) {
    broadcastLiveStatus('loading', '🎙️ Captando sua fala no Microfone...');
  }
});
micVad.on('speech-cancel', () => {
  if (appState.running && !appState.paused && !sttEngine.isBusy()) {
    broadcastLiveStatus('ready', `✓ Escutando em tempo real (${appState.whisperModel} • Zero Tokens)`);
  }
});
micVad.on('final', (seg) => handleVadSegment(seg, false));

loopbackCapture.on('pcm', (pkt) => {
  if (appState.running && !appState.paused && appState.captureSystemAudio) {
    systemVad.pushPcm(pkt.samples);
  }
});

loopbackCapture.on('stopped', (info) => {
  broadcastToWindows('transync:loopback-status', {
    active: false,
    ...info
  });
});

sttEngine.on('status', (statusMsg) => {
  broadcastToWindows('transync:model-status', statusMsg);
});

function createMainWindow() {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0f131a',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    title: 'Transync AI PT-BR ⇄ ES (Microsoft Teams Edition — 100% Gratuito)',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: '#131822',
            symbolColor: '#e2e8f0',
            height: 36
          }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipWindow.close();
    }
  });
}

function createOrTogglePipWindow(forceVisible) {
  const shouldShow =
    typeof forceVisible === 'boolean' ? forceVisible : !appState.pipVisible;

  if (!shouldShow) {
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipZOrderHelper.detach();
      pipWindow.hide();
    }
    appState.pipVisible = false;
    broadcastToWindows('transync:pip-visibility', { visible: false });
    return { visible: false };
  }

  if (!pipWindow || pipWindow.isDestroyed()) {
    const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
    pipWindow = new BrowserWindow({
      width: 540,
      height: 250,
      minWidth: 360,
      minHeight: 140,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      hasShadow: true,
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });

    pipWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    pipWindow.loadFile(path.join(__dirname, '..', 'renderer', 'pip.html'));

    pipWindow.once('ready-to-show', () => {
      if (!pipWindow || pipWindow.isDestroyed()) return;
      pipWindow.show();
      pipWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      pipZOrderHelper.attach(pipWindow, process.pid);
      pipWindow.webContents.send('transync:init-state', getPublicState());
    });

    pipWindow.on('closed', () => {
      pipZOrderHelper.detach();
      pipWindow = null;
      appState.pipVisible = false;
      broadcastToWindows('transync:pip-visibility', { visible: false });
    });
  } else {
    pipWindow.show();
    pipWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    pipWindow.moveTop();
    pipZOrderHelper.attach(pipWindow, process.pid);
  }

  appState.pipVisible = true;
  broadcastToWindows('transync:pip-visibility', { visible: true });
  return { visible: true };
}

function getPublicState() {
  return {
    running: appState.running,
    paused: appState.paused,
    captureSystemAudio: appState.captureSystemAudio,
    captureMicAudio: appState.captureMicAudio,
    engineMode: appState.engineMode,
    whisperModel: appState.whisperModel,
    teamsExpectedLang: appState.teamsExpectedLang,
    micExpectedLang: appState.micExpectedLang,
    contextNote: appState.contextNote,
    glossary: appState.glossary,
    entries: appState.entries.slice(-100),
    pipVisible: appState.pipVisible,
    pipOpacity: appState.pipOpacity,
    pipFontSize: appState.pipFontSize,
    loopbackHelperAvailable: loopbackCapture.isAvailable(),
    loopbackHelperPath: loopbackCapture.getHelperPath()
  };
}

function registerIpcHandlers() {
  ipcMain.handle('transync:get-state', () => getPublicState());

  ipcMain.handle('transync:preload-whisper', (_event, modelId) => {
    sttEngine.preloadModel(modelId || appState.whisperModel);
    return { ok: true };
  });

  ipcMain.handle('transync:start-session', async (_event, config = {}) => {
    Object.assign(appState, {
      captureSystemAudio: config.captureSystemAudio ?? appState.captureSystemAudio,
      captureMicAudio: config.captureMicAudio ?? appState.captureMicAudio,
      engineMode: config.engineMode || appState.engineMode,
      whisperModel: config.whisperModel || appState.whisperModel,
      teamsExpectedLang: config.teamsExpectedLang || appState.teamsExpectedLang,
      micExpectedLang: config.micExpectedLang || appState.micExpectedLang
    });

    sttEngine.setConfig({
      modelId: appState.whisperModel,
      groqFreeApiKey: config.groqFreeApiKey
    });

    systemVad.reset();
    micVad.reset();
    sttEngine.clearQueue();
    appState.running = true;
    appState.paused = false;

    let loopbackStatus = { started: false, mode: 'disabled' };
    if (appState.captureSystemAudio && loopbackCapture.isAvailable()) {
      try {
        loopbackStatus = await loopbackCapture.start(process.pid);
        broadcastToWindows('transync:loopback-status', {
          active: true,
          ...loopbackStatus
        });
      } catch (err) {
        loopbackStatus = { started: false, error: err.message };
      }
    }

    sttEngine.preloadModel(appState.whisperModel);
    broadcastToWindows('transync:session-state', getPublicState());
    return {
      ok: true,
      loopbackStatus,
      state: getPublicState()
    };
  });

  ipcMain.handle('transync:pause-session', (_event, paused) => {
    appState.paused = typeof paused === 'boolean' ? paused : !appState.paused;
    if (appState.paused) {
      systemVad.flushCurrentUtterance();
      micVad.flushCurrentUtterance();
    }
    broadcastToWindows('transync:session-state', getPublicState());
    return { ok: true, paused: appState.paused };
  });

  ipcMain.handle('transync:stop-session', async () => {
    appState.running = false;
    appState.paused = false;
    systemVad.reset();
    micVad.reset();
    sttEngine.clearQueue();
    await loopbackCapture.stop();
    broadcastLiveStatus('ready', `Motor ${appState.whisperModel} pronto (Sessão parada)`);
    broadcastToWindows('transync:session-state', getPublicState());
    return { ok: true, state: getPublicState() };
  });

  ipcMain.on('transync:mic-pcm', (_event, int16ArrayPayload) => {
    if (!appState.running || appState.paused || !appState.captureMicAudio) return;
    // Se o áudio do PC / Teams estiver falando alto neste exato instante (< 280ms),
    // evita que o microfone do notebook re-capture o som das caixas de som do PC (anti-eco)
    if (appState.captureSystemAudio && Date.now() - lastSystemActiveAt < 280) {
      return;
    }
    const samples =
      int16ArrayPayload instanceof Int16Array
        ? int16ArrayPayload
        : new Int16Array(int16ArrayPayload);
    micVad.pushPcm(samples);
  });

  ipcMain.handle('transync:submit-recognized-text', async (_event, payload) => {
    if (!payload || !payload.text) return { ok: false };
    const entry = await processRecognizedText({
      utteranceId: payload.utteranceId,
      source: payload.source || 'mic',
      rawText: payload.text,
      isPartial: Boolean(payload.isPartial)
    });
    return { ok: true, entry };
  });

  ipcMain.handle('transync:run-demo-test', async () => {
    broadcastLiveStatus('loading', '🧪 Executando teste de transcrição e tradução PT-BR ⇄ ES...');

    const tmpWav = path.join(os.tmpdir(), `transync_demo_${Date.now()}.wav`);
    const ps = `
      Add-Type -AssemblyName System.Speech
      $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
      $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
      $synth.SetOutputToWaveFile('${tmpWav.replace(/'/g, "''")}', $format)
      $synth.Speak('Olá equipe, precisamos revisar o orçamento e compartilhar a tela na reunião.')
      $synth.Dispose()
    `;

    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], async (err) => {
        try {
          let transcribed = '';
          let elapsedMs = 0;
          if (!err && fs.existsSync(tmpWav)) {
            const wavBuf = fs.readFileSync(tmpWav);
            try { fs.unlinkSync(tmpWav); } catch {}
            const pcmInt16 = new Int16Array(
              wavBuf.buffer,
              wavBuf.byteOffset + 44,
              Math.floor((wavBuf.byteLength - 44) / 2)
            );
            const float32 = int16ToFloat32(pcmInt16);
            const t0 = Date.now();
            transcribed = await sttEngine.transcribeSegment({
              source: 'mic',
              int16Samples: pcmInt16,
              float32Samples: float32,
              languageHint: 'pt-BR',
              isPartial: false
            });
            elapsedMs = Date.now() - t0;
          }

          const entry = await processRecognizedText({
            utteranceId: `demo_pt_${Date.now()}`,
            source: 'mic',
            rawText:
              transcribed ||
              'Olá equipe, precisamos revisar o orçamento e compartilhar a tela na reunião.',
            isPartial: false,
            bypassDedup: true
          });

          const replyEntry = await processRecognizedText({
            utteranceId: `demo_es_${Date.now() + 1}`,
            source: 'system',
            rawText:
              'Perfecto, ya actualicé el presupuesto del proyecto y ahora voy a compartir mi pantalla con todo el equipo.',
            isPartial: false,
            bypassDedup: true
          });

          broadcastLiveStatus('ready', `✓ Teste concluído em ${(elapsedMs / 1000).toFixed(1)}s!`);
          resolve({ ok: true, elapsedMs, entry, replyEntry });
        } catch (e) {
          broadcastLiveStatus('warn', `Erro no teste: ${e.message}`);
          resolve({ ok: false, error: e.message });
        }
      });
    });
  });

  ipcMain.handle('transync:quick-translate', async (_event, { text, direction }) => {
    const forceSourceLang =
      direction === 'es->pt-BR' ? 'es' : direction === 'pt-BR->es' ? 'pt-BR' : 'auto';
    return await translateBidirectionalPtBrEs(text, {
      forceSourceLang,
      glossary: appState.glossary
    });
  });

  ipcMain.handle('transync:update-config', (_event, partialConfig = {}) => {
    if (typeof partialConfig.teamsExpectedLang === 'string') {
      appState.teamsExpectedLang = partialConfig.teamsExpectedLang;
    }
    if (typeof partialConfig.micExpectedLang === 'string') {
      appState.micExpectedLang = partialConfig.micExpectedLang;
    }
    if (typeof partialConfig.engineMode === 'string') {
      appState.engineMode = partialConfig.engineMode;
    }
    if (typeof partialConfig.whisperModel === 'string') {
      appState.whisperModel = partialConfig.whisperModel;
      sttEngine.setConfig({ modelId: appState.whisperModel });
    }
    if (typeof partialConfig.groqFreeApiKey === 'string') {
      sttEngine.setConfig({ groqFreeApiKey: partialConfig.groqFreeApiKey });
    }
    if (typeof partialConfig.contextNote === 'string') {
      appState.contextNote = partialConfig.contextNote;
    }
    if (Array.isArray(partialConfig.glossary)) {
      appState.glossary = partialConfig.glossary;
    }
    if (typeof partialConfig.pipOpacity === 'number') {
      appState.pipOpacity = partialConfig.pipOpacity;
    }
    if (typeof partialConfig.pipFontSize === 'number') {
      appState.pipFontSize = partialConfig.pipFontSize;
    }
    broadcastToWindows('transync:session-state', getPublicState());
    return { ok: true, state: getPublicState() };
  });

  ipcMain.handle('transync:clear-entries', () => {
    appState.entries = [];
    recentUtteranceFingerprints.length = 0;
    broadcastToWindows('transync:entries-cleared', {});
    return { ok: true };
  });

  ipcMain.handle('transync:toggle-pip', (_event, visible) => {
    return createOrTogglePipWindow(visible);
  });

  ipcMain.handle('transync:generate-summary', () => {
    const markdown = generateMeetingSummaryPtBr(appState.entries, {
      context: appState.contextNote
    });
    return { ok: true, markdown };
  });

  ipcMain.handle('transync:export-transcript', async (_event, { format = 'md' } = {}) => {
    const markdown = generateMeetingSummaryPtBr(appState.entries, {
      context: appState.contextNote
    });
    const defaultName = `Reuniao-Teams-PTBR-ES-${new Date().toISOString().slice(0, 10)}.${format}`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar Transcrição e Ata Bilíngue (PT-BR ⇄ ES)',
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown / Texto', extensions: ['md', 'txt'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    });

    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }

    const content =
      filePath.endsWith('.json')
        ? JSON.stringify(appState.entries, null, 2)
        : markdown;
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  });

  ipcMain.handle('transync:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  try {
    sttEngine.cacheDir = path.join(app.getPath('userData'), 'models-cache');
  } catch {}
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'notifications', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  registerIpcHandlers();
  createMainWindow();

  setTimeout(() => {
    sttEngine.preloadModel(appState.whisperModel);
  }, 300);
});

app.on('before-quit', async () => {
  pipZOrderHelper.detach();
  await loopbackCapture.stop();
  await sttEngine.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
