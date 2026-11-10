'use strict';

const { parentPort } = require('node:worker_threads');
const path = require('node:path');

let transcriber = null;
let loadedModelId = null;
let loadingPromise = null;

const WHISPER_HALLUCINATION_PATTERNS = [
  /^\[.*\]$/i,
  /^\(.*\)$/i,
  /^♪+$/,
  /^obrigado por assistir/i,
  /^legendas pela comunidade/i,
  /^subtítulos realizados por/i,
  /^subtitulado por/i,
  /^amara\.org/i,
  /^gracias por ver/i,
  /^suscríbete/i,
  /^\.+$/
];

function isWhisperHallucination(text) {
  const clean = String(text || '').trim();
  if (!clean || clean.length < 2) return true;
  for (const pat of WHISPER_HALLUCINATION_PATTERNS) {
    if (pat.test(clean)) return true;
  }
  return false;
}

async function getTranscriber(modelId = 'Xenova/whisper-tiny', cacheDir = null) {
  if (transcriber && loadedModelId === modelId) {
    return transcriber;
  }
  if (loadingPromise && loadedModelId === modelId) {
    return loadingPromise;
  }

  loadedModelId = modelId;
  loadingPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    if (cacheDir) {
      env.cacheDir = cacheDir;
    } else {
      env.cacheDir = path.resolve(__dirname, '..', '..', '.cache', 'models');
    }

    parentPort?.postMessage({
      type: 'model-status',
      status: 'loading',
      modelId,
      message: `Carregando motor rápido ${modelId}...`
    });

    const instance = await pipeline('automatic-speech-recognition', modelId, {
      quantized: true,
      progress_callback: (prog) => {
        if (prog && prog.status === 'progress') {
          parentPort?.postMessage({
            type: 'model-progress',
            modelId,
            file: prog.file,
            progress: Math.round(prog.progress || 0)
          });
        }
      }
    });

    transcriber = instance;
    parentPort?.postMessage({
      type: 'model-status',
      status: 'ready',
      modelId,
      message: `Motor ${modelId} aquecido e pronto (~1.2s de resposta • Zero Tokens)`
    });
    return instance;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

parentPort?.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'preload') {
    try {
      await getTranscriber(msg.modelId || 'Xenova/whisper-tiny', msg.cacheDir);
    } catch (err) {
      parentPort?.postMessage({
        type: 'model-status',
        status: 'error',
        modelId: msg.modelId,
        message: `Erro ao carregar Whisper local: ${err.message}`
      });
    }
    return;
  }

  if (msg.type === 'transcribe') {
    const { requestId, float32Audio, languageHint, modelId, cacheDir } = msg;
    try {
      const audioArray =
        float32Audio instanceof Float32Array ? float32Audio : new Float32Array(float32Audio);

      // Verificação rápida de energia mínima para nunca gastar CPU em silêncio
      let sumSq = 0;
      for (let i = 0; i < audioArray.length; i++) {
        sumSq += audioArray[i] * audioArray[i];
      }
      const rms = Math.sqrt(sumSq / Math.max(1, audioArray.length));
      if (rms < 0.004) {
        parentPort?.postMessage({
          type: 'transcribe-result',
          requestId,
          ok: true,
          text: ''
        });
        return;
      }

      const asr = await getTranscriber(modelId || 'Xenova/whisper-tiny', cacheDir);

      const whisperLang =
        languageHint && languageHint.startsWith('pt')
          ? 'portuguese'
          : languageHint && languageHint.startsWith('es')
            ? 'spanish'
            : 'spanish';

      const result = await asr(audioArray, {
        language: whisperLang,
        task: 'transcribe',
        max_new_tokens: 56,
        return_timestamps: false
      });

      const rawText = String(result?.text || '').trim();
      const text = isWhisperHallucination(rawText) ? '' : rawText;

      parentPort?.postMessage({
        type: 'transcribe-result',
        requestId,
        ok: true,
        text
      });
    } catch (err) {
      parentPort?.postMessage({
        type: 'transcribe-result',
        requestId,
        ok: false,
        error: err.message
      });
    }
  }
});
