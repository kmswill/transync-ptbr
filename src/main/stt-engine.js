'use strict';

const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { encodeWav16kMono } = require('./vad-segmenter');

class HybridFreeSttEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.modelId = options.modelId || 'Xenova/whisper-base';
    this.cacheDir = options.cacheDir || path.resolve(__dirname, '..', '..', '.cache', 'models');
    this.groqFreeApiKey = options.groqFreeApiKey || '';
    this.worker = null;
    this.pendingRequests = new Map();
    this.reqCounter = 0;
    this.busyCount = 0;
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
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          this.pendingRequests.delete(msg.requestId);
          this.busyCount = Math.max(0, this.busyCount - 1);
          if (msg.ok) {
            pending.resolve(msg.text || '');
          } else {
            pending.reject(new Error(msg.error || 'Falha na transcrição Whisper'));
          }
        }
      }
    });

    worker.on('error', (err) => {
      this.emit('status', {
        type: 'model-status',
        status: 'error',
        message: `Worker Whisper erro: ${err.message}`
      });
    });

    worker.on('exit', () => {
      this.worker = null;
      this.busyCount = 0;
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Worker Whisper finalizado'));
      }
      this.pendingRequests.clear();
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
    return this.busyCount > 0;
  }

  async transcribeSegment({ int16Samples, float32Samples, languageHint = 'es', isPartial = false }) {
    // Se for parcial e o motor já estiver processando um áudio, descarta o parcial antigo para manter latência mínima
    if (isPartial && this.busyCount > 0) {
      return '';
    }

    // Se o usuário tiver configurado chave gratuita opcional do Groq Whisper-Large-v3-Turbo
    if (this.groqFreeApiKey && int16Samples && !isPartial) {
      try {
        const text = await this.transcribeViaGroqFreeTier(int16Samples, languageHint);
        if (text) return text;
      } catch {
        // Faz fallback transparente para o Whisper Local ONNX
      }
    }

    const worker = this.ensureWorker();
    this.reqCounter += 1;
    const requestId = `req_${Date.now()}_${this.reqCounter}`;
    this.busyCount += 1;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
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
    });
  }

  async transcribeViaGroqFreeTier(int16Samples, languageHint = 'es') {
    const wavBuffer = encodeWav16kMono(int16Samples);
    const formData = new FormData();
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    formData.append('file', blob, 'segment.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    const isoLang = languageHint.startsWith('pt') ? 'pt' : 'es';
    formData.append('language', isoLang);
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
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

module.exports = {
  HybridFreeSttEngine
};
