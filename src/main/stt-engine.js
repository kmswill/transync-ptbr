'use strict';

const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { encodeWav16kMono, concatInt16Chunks, int16ToFloat32 } = require('./vad-segmenter');

const MAX_COALESCED_SAMPLES = 16000 * 11; // Máx 11s por lote combinado

const WHISPER_HALLUCINATION_PATTERNS = [
  /^\[.*\]$/i,
  /^\(.*\)$/i,
  /^♪+$/,
  /^obrigado por assistir/i,
  /^obrigado\.?$/i,
  /^legendas pela comunidade/i,
  /^subtítulos realizados por/i,
  /^subtitulado por/i,
  /^amara\.org/i,
  /^gracias por ver/i,
  /^suscríbete/i,
  /^thank you for watching/i,
  /^convers[aã]o de reuni[aã]o corporativa/i,
  /^\.+$/
];

function sanitizeWhisperText(rawText) {
  let clean = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 2) return '';

  for (const pat of WHISPER_HALLUCINATION_PATTERNS) {
    if (pat.test(clean)) return '';
  }

  clean = clean.replace(/(.{4,30}?)(?:\s*\1){2,}/giu, '$1');

  const words = clean.split(/\s+/);
  const deduped = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev1 = deduped[deduped.length - 1];
    const prev2 = deduped[deduped.length - 2];
    const normW = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const normPrev1 = prev1 ? prev1.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';
    const normPrev2 = prev2 ? prev2.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : '';

    if (normW && normW === normPrev1 && normW.length >= 2) {
      continue;
    }
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

function hasEnoughSpeechEnergy(float32Samples) {
  if (!float32Samples || float32Samples.length < 16000 * 0.25) return false;
  let sumSq = 0;
  let activeSamples = 0;
  for (let i = 0; i < float32Samples.length; i++) {
    const v = float32Samples[i];
    sumSq += v * v;
    if (Math.abs(v) > 0.016) activeSamples++;
  }
  const rms = Math.sqrt(sumSq / float32Samples.length);
  return rms >= 0.0055 && activeSamples >= 16000 * 0.18;
}

function concatFloat32(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

class HybridFreeSttEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.modelId = options.modelId || 'Xenova/whisper-tiny';
    this.cacheDir = options.cacheDir || path.resolve(__dirname, '..', '..', '.cache', 'models');
    this.groqFreeApiKey = String(options.groqFreeApiKey || '').trim();
    this.worker = null;
    this.activeRequests = new Map();
    this.reqCounter = 0;
    this.workerBusy = false;
    this.groqInFlight = 0;
    this.coalescedQueue = [];
  }

  hasGroqKey() {
    return Boolean(this.groqFreeApiKey && this.groqFreeApiKey.startsWith('gsk_'));
  }

  // Modelo usado no fallback local (CPU); nunca tenta carregar o ID "groq/..." no ONNX
  getLocalModelId() {
    return this.modelId && this.modelId.startsWith('Xenova/') ? this.modelId : 'Xenova/whisper-tiny';
  }

  ensureWorker() {
    if (this.worker) {
      return this.worker;
    }

    const workerPath = path.join(__dirname, 'whisper-worker.js');
    const worker = new Worker(workerPath);

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'model-status' || msg.type === 'model-progress') {
        this.emit('status', msg);
        return;
      }
      if (msg.type === 'transcribe-result') {
        const pending = this.activeRequests.get(msg.requestId);
        if (pending) {
          this.activeRequests.delete(msg.requestId);
          this.workerBusy = false;
          if (msg.ok) {
            pending.resolve(msg.text || '');
          } else {
            pending.reject(new Error(msg.error || 'Falha na transcrição Whisper'));
          }
          this._drainQueue();
        }
      }
    });

    worker.on('error', (err) => {
      this.workerBusy = false;
      this.emit('status', {
        type: 'model-status',
        status: 'error',
        message: `Worker Whisper erro: ${err.message}`
      });
      this._drainQueue();
    });

    worker.on('exit', () => {
      this.worker = null;
      this.workerBusy = false;
      for (const [, pending] of this.activeRequests) {
        pending.reject(new Error('Worker Whisper finalizado'));
      }
      this.activeRequests.clear();
    });

    this.worker = worker;
    return worker;
  }

  preloadModel(modelId = this.modelId) {
    this.modelId = modelId;
    if (this.hasGroqKey()) {
      this.emit('status', {
        type: 'model-status',
        status: 'ready',
        modelId: 'groq/whisper-large-v3-turbo',
        message: '🚀 Motor Groq Whisper-Large-v3-Turbo Ativo (~0.3s • Grátis)'
      });
      return;
    }
    const worker = this.ensureWorker();
    worker.postMessage({
      type: 'preload',
      modelId: this.getLocalModelId(),
      cacheDir: this.cacheDir
    });
  }

  setConfig({ modelId, groqFreeApiKey } = {}) {
    if (typeof groqFreeApiKey === 'string') {
      this.groqFreeApiKey = groqFreeApiKey.trim();
    }
    if (modelId && modelId !== this.modelId) {
      this.modelId = modelId;
    }
    this.preloadModel(this.modelId);
  }

  isBusy() {
    return this.workerBusy || this.groqInFlight > 0 || this.coalescedQueue.length > 0;
  }

  clearQueue() {
    while (this.coalescedQueue.length > 0) {
      const item = this.coalescedQueue.shift();
      item.resolve('');
    }
  }

  async transcribeSegment({
    source = 'system',
    int16Samples,
    float32Samples,
    languageHint = 'auto',
    isPartial = false
  }) {
    const f32 =
      float32Samples instanceof Float32Array
        ? float32Samples
        : int16Samples
          ? int16ToFloat32(int16Samples)
          : new Float32Array(0);

    if (!hasEnoughSpeechEnergy(f32)) {
      return '';
    }

    // CAMINHO 1 (TURBO): Groq Whisper-Large-v3-Turbo (~250ms, 809M params, 0% CPU)
    if (this.hasGroqKey() && int16Samples) {
      try {
        this.groqInFlight += 1;
        const text = await this.transcribeViaGroqFreeTier(int16Samples, languageHint);
        this.groqInFlight = Math.max(0, this.groqInFlight - 1);
        return sanitizeWhisperText(text);
      } catch (err) {
        this.groqInFlight = Math.max(0, this.groqInFlight - 1);
        // Se falhar (ex: sem internet ou rate-limit momentâneo), faz fallback automático para o Whisper local
      }
    }

    if (isPartial && this.workerBusy) {
      return '';
    }

    // CAMINHO 2 (FALLBACK OFFLINE): Whisper Local ONNX na CPU com fusão de fila
    return new Promise((resolve, reject) => {
      if (this.workerBusy) {
        const existingIdx = this.coalescedQueue.findIndex((q) => q.source === source);
        if (existingIdx >= 0) {
          const existing = this.coalescedQueue[existingIdx];
          if (existing.float32Samples.length + f32.length <= MAX_COALESCED_SAMPLES) {
            existing.float32Samples = concatFloat32(existing.float32Samples, f32);
            if (existing.int16Samples && int16Samples) {
              existing.int16Samples = concatInt16Chunks([existing.int16Samples, int16Samples]);
            }
            existing.languageHint = languageHint;
            existing.resolve('');
            existing.resolve = resolve;
            existing.reject = reject;
            return;
          }
        }
        this.coalescedQueue.push({
          source,
          int16Samples,
          float32Samples: f32,
          languageHint,
          resolve,
          reject
        });
        return;
      }

      this._dispatchToWorker({
        float32Samples: f32,
        languageHint,
        resolve,
        reject
      });
    });
  }

  _drainQueue() {
    if (this.workerBusy || this.coalescedQueue.length === 0) return;
    const next = this.coalescedQueue.shift();
    if (!next) return;
    this._dispatchToWorker(next);
  }

  _dispatchToWorker({ float32Samples, languageHint, resolve, reject }) {
    const worker = this.ensureWorker();
    this.reqCounter += 1;
    const requestId = `req_${Date.now()}_${this.reqCounter}`;
    this.workerBusy = true;

    this.activeRequests.set(requestId, { resolve, reject });
    const copy = new Float32Array(float32Samples);
    worker.postMessage(
      {
        type: 'transcribe',
        requestId,
        float32Audio: copy,
        languageHint,
        modelId: this.getLocalModelId(),
        cacheDir: this.cacheDir
      },
      [copy.buffer]
    );
  }

  async transcribeViaGroqFreeTier(int16Samples, languageHint = 'auto') {
    const wavBuffer = encodeWav16kMono(int16Samples);
    const formData = new FormData();
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    formData.append('file', blob, 'segment.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('temperature', '0');
    if (languageHint && languageHint !== 'auto') {
      const isoLang = languageHint.startsWith('pt') ? 'pt' : 'es';
      formData.append('language', isoLang);
    }
    formData.append('response_format', 'json');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);
    try {
      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.groqFreeApiKey}`
        },
        body: formData,
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Groq HTTP ${response.status}`);
      }
      const data = await response.json();
      return sanitizeWhisperText(data?.text || '');
    } finally {
      clearTimeout(timeout);
    }
  }

  async destroy() {
    this.clearQueue();
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

module.exports = {
  HybridFreeSttEngine,
  sanitizeWhisperText,
  hasEnoughSpeechEnergy
};
