'use strict';

const { EventEmitter } = require('node:events');

const SAMPLE_RATE = 16000;

/**
 * Calcula o RMS normalizado (0.0 a 1.0) e nível visual (0 a 100) de um Int16Array.
 */
function calculateAudioLevel(int16Samples) {
  if (!int16Samples || int16Samples.length === 0) {
    return { rms: 0, level: 0 };
  }
  let sumSq = 0;
  for (let i = 0; i < int16Samples.length; i++) {
    const norm = int16Samples[i] / 32768;
    sumSq += norm * norm;
  }
  const rms = Math.sqrt(sumSq / int16Samples.length);
  const level = Math.min(100, Math.round(rms * 350));
  return { rms, level };
}

/**
 * Converte Int16Array em Float32Array (-1.0 a 1.0) esperado pelo Whisper ONNX.
 */
function int16ToFloat32(int16Samples) {
  const float32 = new Float32Array(int16Samples.length);
  for (let i = 0; i < int16Samples.length; i++) {
    float32[i] = Math.max(-1, Math.min(1, int16Samples[i] / 32768));
  }
  return float32;
}

/**
 * Empacota um Int16Array (16kHz Mono) em um Buffer WAV RIFF válido de 16 bits.
 */
function encodeWav16kMono(int16Samples) {
  const byteLength = int16Samples.length * 2;
  const buffer = Buffer.alloc(44 + byteLength);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + byteLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(byteLength, 40);

  for (let i = 0; i < int16Samples.length; i++) {
    buffer.writeInt16LE(int16Samples[i], 44 + i * 2);
  }
  return buffer;
}

/**
 * Concatena uma lista de chunks Int16Array em um único Int16Array.
 */
function concatInt16Chunks(chunks) {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }
  const merged = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * Segmentador de voz em tempo real (VAD) com:
 * - Piso de ruído adaptativo (ignora ruído constante de fundo)
 * - Corte suave em micro-pausas (soft-cut a partir de 2.6s quando há 180ms de pausa entre palavras)
 *   para nunca decepar palavras ao meio
 * - Overlap de 180ms quando uma fala contínua atinge maxSegmentMs
 */
class RealtimeVadSegmenter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.source = options.source || 'system';
    this.speechThresholdRms = options.speechThresholdRms ?? 0.014;
    this.silenceHangoverMs = options.silenceHangoverMs ?? 450;
    this.softCutStartMs = options.softCutStartMs ?? 3200;
    this.softCutSilenceMs = options.softCutSilenceMs ?? 64;
    this.minSpeechMs = options.minSpeechMs ?? 380;
    this.maxSegmentMs = options.maxSegmentMs ?? 8000;
    this.partialIntervalMs = options.partialIntervalMs ?? 0;
    this.preRollMaxChunks = options.preRollMaxChunks ?? 5;

    this.reset();
  }

  reset() {
    this.preRollChunks = [];
    this.activeChunks = [];
    this.activeSampleCount = 0;
    this.voicedSampleCount = 0;
    this.silenceMs = 0;
    this.sinceLastPartialMs = 0;
    this.speaking = false;
    this.speechStartEmitted = false;
    this.currentUtteranceId = null;
    this.utteranceCounter = this.utteranceCounter || 0;
    this.noiseFloorRms = 0.004;
  }

  pushPcm(int16Samples) {
    if (!int16Samples || int16Samples.length === 0) {
      return;
    }

    const chunkDurationMs = (int16Samples.length / SAMPLE_RATE) * 1000;
    const { rms, level } = calculateAudioLevel(int16Samples);
    this.emit('level', { source: this.source, rms, level });

    if (!this.speaking && rms < this.speechThresholdRms * 1.4) {
      this.noiseFloorRms = this.noiseFloorRms * 0.94 + rms * 0.06;
    }

    const dynamicThreshold = Math.max(
      this.speechThresholdRms,
      Math.min(0.048, this.noiseFloorRms * 2.5)
    );
    const isVoiced = rms >= dynamicThreshold;

    if (!this.speaking) {
      this.preRollChunks.push(int16Samples);
      if (this.preRollChunks.length > this.preRollMaxChunks) {
        this.preRollChunks.shift();
      }

      if (isVoiced) {
        this.speaking = true;
        this.speechStartEmitted = false;
        this.utteranceCounter += 1;
        this.currentUtteranceId = `${this.source}_utt_${Date.now()}_${this.utteranceCounter}`;
        this.activeChunks = [...this.preRollChunks];
        this.preRollChunks = [];
        this.activeSampleCount = this.activeChunks.reduce((acc, c) => acc + c.length, 0);
        this.voicedSampleCount = int16Samples.length;
        this.silenceMs = 0;
        this.sinceLastPartialMs = 0;
      }
      return;
    }

    // Fala ativa
    this.activeChunks.push(int16Samples);
    this.activeSampleCount += int16Samples.length;

    if (isVoiced) {
      this.voicedSampleCount += int16Samples.length;
      this.silenceMs = 0;
    } else {
      this.silenceMs += chunkDurationMs;
    }

    const totalDurationMs = (this.activeSampleCount / SAMPLE_RATE) * 1000;
    const voicedDurationMs = (this.voicedSampleCount / SAMPLE_RATE) * 1000;

    // Só emite speech-start depois que houver fala real suficiente (>= minSpeechMs / 2)
    if (!this.speechStartEmitted && voicedDurationMs >= Math.min(220, this.minSpeechMs)) {
      this.speechStartEmitted = true;
      this.emit('speech-start', {
        source: this.source,
        utteranceId: this.currentUtteranceId
      });
    }

    this.sinceLastPartialMs += chunkDurationMs;

    if (
      this.partialIntervalMs > 0 &&
      this.sinceLastPartialMs >= this.partialIntervalMs &&
      voicedDurationMs >= this.minSpeechMs
    ) {
      this.sinceLastPartialMs = 0;
      const merged = concatInt16Chunks(this.activeChunks);
      this.emit('partial', {
        source: this.source,
        utteranceId: this.currentUtteranceId,
        int16Samples: merged,
        float32Samples: int16ToFloat32(merged),
        durationMs: Math.round(totalDurationMs)
      });
    }

    // Corte inteligente:
    // 1. Pausa normal (silenceHangoverMs ~ 450ms)
    // 2. Micro-pausa entre palavras (softCutSilenceMs ~ 180ms) quando o segmento já passou de softCutStartMs (2.6s)
    // 3. Limite máximo de segurança (maxSegmentMs ~ 5.5s)
    const shouldSoftCut =
      totalDurationMs >= this.softCutStartMs && this.silenceMs >= this.softCutSilenceMs;
    const shouldHardCut = totalDurationMs >= this.maxSegmentMs;

    if (this.silenceMs >= this.silenceHangoverMs || shouldSoftCut || shouldHardCut) {
      this.flushCurrentUtterance(shouldHardCut && !shouldSoftCut);
    }
  }

  flushCurrentUtterance(keepBoundaryOverlap = false) {
    if (!this.speaking || this.activeChunks.length === 0) {
      this.speaking = false;
      this.speechStartEmitted = false;
      this.activeChunks = [];
      this.activeSampleCount = 0;
      return;
    }

    const voicedDurationMs = (this.voicedSampleCount / SAMPLE_RATE) * 1000;
    const totalDurationMs = (this.activeSampleCount / SAMPLE_RATE) * 1000;
    const utteranceId = this.currentUtteranceId;
    const chunks = this.activeChunks;
    const hadSpeechStart = this.speechStartEmitted;

    // Se precisou cortar no limite máximo no meio da fala, preserva os últimos 3 chunks (~190ms) no preRoll
    if (keepBoundaryOverlap && chunks.length >= 3) {
      this.preRollChunks = chunks.slice(-3);
    } else {
      this.preRollChunks = [];
    }

    this.speaking = false;
    this.speechStartEmitted = false;
    this.activeChunks = [];
    this.activeSampleCount = 0;
    this.voicedSampleCount = 0;
    this.silenceMs = 0;
    this.sinceLastPartialMs = 0;
    this.currentUtteranceId = null;

    if (voicedDurationMs < this.minSpeechMs) {
      if (hadSpeechStart) {
        this.emit('speech-cancel', { source: this.source, utteranceId });
      }
      return;
    }

    const merged = concatInt16Chunks(chunks);
    this.emit('final', {
      source: this.source,
      utteranceId,
      int16Samples: merged,
      float32Samples: int16ToFloat32(merged),
      durationMs: Math.round(totalDurationMs)
    });
  }
}

module.exports = {
  RealtimeVadSegmenter,
  calculateAudioLevel,
  int16ToFloat32,
  encodeWav16kMono,
  concatInt16Chunks,
  SAMPLE_RATE
};
