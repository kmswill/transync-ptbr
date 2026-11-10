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
  /^thank you for watching/i,
  /^\.+$/
];

/**
 * Remove loops de repetição do Whisper (ex: "Pioço de Pioço de..." ou "sí, sí, sí")
 * e filtra alucinações de silêncio/ruído.
 */
function sanitizeWhisperText(rawText) {
  let clean = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 2) return '';

  for (const pat of WHISPER_HALLUCINATION_PATTERNS) {
    if (pat.test(clean)) return '';
  }

  // Remove qualquer sequência de 4+ caracteres que se repita 3+ vezes seguidas (mesmo sem espaço)
  clean = clean.replace(/(.{4,30}?)(?:\s*\1){2,}/giu, '$1');

  // Remove palavras ou pares de palavras repetidos em sequência
  const words = clean.split(/\s+/);
  const deduped = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev1 = deduped[deduped.length - 1];
    const prev2 = deduped[deduped.length - 2];
    const normW = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const normPrev1 = prev1 ? prev1.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
    const normPrev2 = prev2 ? prev2.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';

    // Evita mesma palavra 2x seguidas (ex: "hola hola")
    if (normW && normW === normPrev1 && normW.length >= 2) {
      continue;
    }
    // Evita bigrama repetido (ex: "de pioço de pioço")
    if (
      normW &&
      i + 1 < words.length &&
      normW === normPrev2 &&
      words[i + 1].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === normPrev1
    ) {
      i += 1;
      continue;
    }
    deduped.push(w);
  }

  clean = deduped.join(' ').trim();
  const lettersOnly = clean.replace(/[^\p{L}]/gu, '');
  if (lettersOnly.length < 3) return '';

  return clean;
}

/**
 * Aplica fade-out suave nos últimos 25ms e adiciona 300ms de silêncio ao final do buffer
 * para que o decodificador do Whisper perceba fim limpo de frase e não entre em loop.
 */
function padAudioWithCleanTail(audioArray) {
  const fadeSamples = Math.min(400, audioArray.length); // 25ms a 16kHz
  const tailSilenceSamples = 4800; // 300ms a 16kHz
  const padded = new Float32Array(audioArray.length + tailSilenceSamples);
  padded.set(audioArray, 0);

  const startFade = audioArray.length - fadeSamples;
  for (let i = 0; i < fadeSamples; i++) {
    const factor = 1 - i / fadeSamples;
    padded[startFade + i] *= factor;
  }
  return padded;
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
      message: `Carregando motor ${modelId}...`
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
      message: `Motor ${modelId} pronto (Tempo Real • Zero Tokens)`
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

      let sumSq = 0;
      let activeSamples = 0;
      for (let i = 0; i < audioArray.length; i++) {
        const v = audioArray[i];
        sumSq += v * v;
        if (Math.abs(v) > 0.018) activeSamples++;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, audioArray.length));
      if (rms < 0.006 || activeSamples < 16000 * 0.22) {
        parentPort?.postMessage({
          type: 'transcribe-result',
          requestId,
          ok: true,
          text: ''
        });
        return;
      }

      const asr = await getTranscriber(modelId || 'Xenova/whisper-tiny', cacheDir);

      let whisperLang = null;
      if (languageHint && languageHint !== 'auto') {
        if (languageHint.startsWith('pt')) {
          whisperLang = 'portuguese';
        } else if (languageHint.startsWith('es')) {
          whisperLang = 'spanish';
        }
      }

      const genOptions = {
        task: 'transcribe',
        max_new_tokens: 64,
        no_repeat_ngram_size: 3,
        repetition_penalty: 1.15,
        return_timestamps: false
      };
      if (whisperLang) {
        genOptions.language = whisperLang;
      }

      const paddedAudio = padAudioWithCleanTail(audioArray);
      const result = await asr(paddedAudio, genOptions);
      const text = sanitizeWhisperText(result?.text || '');

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
