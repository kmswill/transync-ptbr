'use strict';

const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { encodeWav16kMono, concatInt16Chunks, int16ToFloat32 } = require('./vad-segmenter');

const MAX_COALESCED_SAMPLES = 16000 * 11; // Máx 11s por lote combinado

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
    this.groqFreeApiKey = options.groqFreeApiKey || '';
    this.worker = null;
    this.activeRequests = new Map();
    this.reqCounter = 0;
    this.workerBusy = false;
    this.coalescedQueue = []; // Fila inteligente (no máximo 1 item por source aguardando)
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
    const worker = this.ensureWorker();
    worker.postMessage({
      type: 'preload',
      modelId: this.modelId,
      cacheDir: this.cacheDir
    });
  }

  setConfig({ modelId, groqFreeApiKey } = {}) {
    if (modelId && modelId !== this.modelId) {
      this.modelId = modelId;
      this.preloadModel(modelId);
    }
    if (typeof groqFreeApiKey === 'string') {
      this.groqFreeApiKey = groqFreeApiKey.trim();
    }
  }

  isBusy() {
    return this.workerBusy || this.coalescedQueue.length > 0;
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
    if (isPartial && this.workerBusy) {
      return '';
    }

    const f32 =
      float32Samples instanceof Float32Array
        ? float32Samples
        : int16Samples
          ? int16ToFloat32(int16Samples)
          : new Float32Array(0);

    if (f32.length === 0) return '';

    // Se o usuário tiver configurado chave gratuita opcional do Groq Whisper-Large-v3-Turbo
    if (this.groqFreeApiKey && int16Samples && !isPartial) {
      try {
        const text = await this.transcribeViaGroqFreeTier(int16Samples, languageHint);
        if (text) return text;
      } catch {
        // Fallback transparente para o Whisper Local ONNX
      }
    }

    return new Promise((resolve, reject) => {
      // Se o worker já estiver ocupado, funde segmentos pendentes da mesma fonte (evita fila infinita e frases picotadas)
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
            // Libera a promise anterior silenciosamente; a nova promise receberá o texto unido completo
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
        modelId: this.modelId,
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
    if (languageHint && languageHint !== 'auto') {
      const isoLang = languageHint.startsWith('pt') ? 'pt' : 'es';
      formData.append('language', isoLang);
    }
    formData.append('response_format', 'json');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.groqFreeApiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Groq HTTP ${response.status}`);
    }
    const data = await response.json();
    return String(data?.text || '').trim();
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
  HybridFreeSttEngine
};
