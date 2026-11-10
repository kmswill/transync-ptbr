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
  const level = Math.min(100, Math.round(rms * 320));
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
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  buffer.writeUInt16LE(1, 22); // NumChannels (1 = Mono)
  buffer.writeUInt32LE(SAMPLE_RATE, 24); // SampleRate (16000)
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // ByteRate
  buffer.writeUInt16LE(2, 32); // BlockAlign
  buffer.writeUInt16LE(16, 34); // BitsPerSample
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
 * Segmentador de voz em tempo real (VAD) para fluxos PCM 16kHz.
 * Emite eventos 'level', 'partial' (enquanto a pessoa ainda está falando)
 * e 'final' (assim que faz uma pausa natural).
 */
class RealtimeVadSegmenter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.source = options.source || 'system';
    this.speechThresholdRms = options.speechThresholdRms ?? 0.011;
    this.silenceHangoverMs = options.silenceHangoverMs ?? 560;
    this.minSpeechMs = options.minSpeechMs ?? 420;
    this.maxSegmentMs = options.maxSegmentMs ?? 8500;
    this.partialIntervalMs = options.partialIntervalMs ?? 1600;
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
    this.currentUtteranceId = null;
    this.utteranceCounter = this.utteranceCounter || 0;
  }

  pushPcm(int16Samples) {
    if (!int16Samples || int16Samples.length === 0) {
      return;
    }

    const chunkDurationMs = (int16Samples.length / SAMPLE_RATE) * 1000;
    const { rms, level } = calculateAudioLevel(int16Samples);
    this.emit('level', { source: this.source, rms, level });

    const isVoiced = rms >= this.speechThresholdRms;

    if (!this.speaking) {
      this.preRollChunks.push(int16Samples);
      if (this.preRollChunks.length > this.preRollMaxChunks) {
        this.preRollChunks.shift();
      }

      if (isVoiced) {
        this.speaking = true;
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

    // Já estamos em um segmento de fala ativo
    this.activeChunks.push(int16Samples);
    this.activeSampleCount += int16Samples.length;

    const totalDurationMs = (this.activeSampleCount / SAMPLE_RATE) * 1000;
    const voicedDurationMs = (this.voicedSampleCount / SAMPLE_RATE) * 1000;

    if (isVoiced) {
      this.voicedSampleCount += int16Samples.length;
      this.silenceMs = 0;
    } else {
      this.silenceMs += chunkDurationMs;
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

    if (this.silenceMs >= this.silenceHangoverMs || totalDurationMs >= this.maxSegmentMs) {
      this.flushCurrentUtterance();
    }
  }

  flushCurrentUtterance() {
    if (!this.speaking || this.activeChunks.length === 0) {
      this.speaking = false;
      this.activeChunks = [];
      this.activeSampleCount = 0;
      return;
    }

    const voicedDurationMs = (this.voicedSampleCount / SAMPLE_RATE) * 1000;
    const totalDurationMs = (this.activeSampleCount / SAMPLE_RATE) * 1000;
    const utteranceId = this.currentUtteranceId;
    const chunks = this.activeChunks;

    this.speaking = false;
    this.activeChunks = [];
    this.activeSampleCount = 0;
    this.voicedSampleCount = 0;
    this.silenceMs = 0;
    this.sinceLastPartialMs = 0;
    this.currentUtteranceId = null;

    if (voicedDurationMs < this.minSpeechMs) {
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
