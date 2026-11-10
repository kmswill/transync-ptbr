'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectLanguagePtBrOrEs,
  normalizeToBrazilianPortuguese,
  applyGlossary
} = require('../src/main/translator');
const {
  RealtimeVadSegmenter,
  encodeWav16kMono
} = require('../src/main/vad-segmenter');
const {
  decodeBase64PcmInt16,
  resampleInt16To16kHz
} = require('../src/main/audio-loopback');
const {
  generateMeetingSummaryPtBr
} = require('../src/main/meeting-summary');

test('detectLanguagePtBrOrEs distingue Espanhol (es) e Português do Brasil (pt-BR)', () => {
  assert.equal(
    detectLanguagePtBrOrEs('Hola equipo, necesitamos revisar el presupuesto de la reunión de hoy.'),
    'es'
  );
  assert.equal(
    detectLanguagePtBrOrEs('Pessoal, precisamos revisar o orçamento da reunião de hoje com vocês.'),
    'pt-BR'
  );
});

test('normalizeToBrazilianPortuguese converte termos de Portugal (pt-PT) para Português do Brasil (pt-BR)', () => {
  const inputPtPt = 'A equipa está a fazer o planeamento e vai partilhar o ecrã com o ficheiro de faturação.';
  const normalized = normalizeToBrazilianPortuguese(inputPtPt);
  assert.match(normalized, /equipe/);
  assert.match(normalized, /está fazendo/);
  assert.match(normalized, /planejamento/);
  assert.match(normalized, /tela/);
  assert.match(normalized, /arquivo/);
  assert.match(normalized, /faturamento/);
});

test('applyGlossary aplica termos customizados na direção correta', () => {
  const out = applyGlossary(
    'Vamos revisar el presupuesto y el despliegue.',
    'es->pt-BR',
    [{ source: 'despliegue', target: 'deploy em produção', direction: 'es->pt-BR' }]
  );
  assert.match(out, /orçamento/);
  assert.match(out, /deploy em produção/);
});

test('RealtimeVadSegmenter detecta início de fala, emite parcial e finaliza após pausa', () => {
  const vad = new RealtimeVadSegmenter({
    source: 'system',
    speechThresholdRms: 0.02,
    silenceHangoverMs: 180,
    minSpeechMs: 120,
    partialIntervalMs: 120
  });

  const finals = [];
  vad.on('final', (seg) => finals.push(seg));

  const silentChunk = new Int16Array(1024); // 64ms silêncio
  const voicedChunk = new Int16Array(1024).fill(3500); // 64ms voz ativa (~0.106 RMS)

  vad.pushPcm(silentChunk);
  vad.pushPcm(voicedChunk);
  vad.pushPcm(voicedChunk);
  vad.pushPcm(voicedChunk);
  vad.pushPcm(silentChunk);
  vad.pushPcm(silentChunk);
  vad.pushPcm(silentChunk);

  assert.equal(finals.length, 1);
  assert.equal(finals[0].source, 'system');
  assert.ok(finals[0].float32Samples.length >= 1024 * 3);

  const wav = encodeWav16kMono(finals[0].int16Samples);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
});

test('decodeBase64PcmInt16 e resampleInt16To16kHz processam frames PCM corretamente', () => {
  const src = new Int16Array([1000, -1000, 2000, -2000]);
  const b64 = Buffer.from(src.buffer).toString('base64');
  const decoded = decodeBase64PcmInt16(b64);
  assert.deepEqual(Array.from(decoded), [1000, -1000, 2000, -2000]);

  const resampled = resampleInt16To16kHz(new Int16Array(320), 32000, 1);
  assert.equal(resampled.length, 160);
});

test('generateMeetingSummaryPtBr gera ata estruturada em PT-BR', () => {
  const md = generateMeetingSummaryPtBr([
    {
      source: 'system',
      timestamp: '10:15:00',
      sourceLang: 'es',
      targetLang: 'pt-BR',
      sourceText: 'Necesitamos aprobar el presupuesto mañana.',
      translatedText: 'Precisamos aprovar o orçamento amanhã.'
    }
  ]);
  assert.match(md, /Ata & Resumo da Reunião/);
  assert.match(md, /Precisamos aprovar o orçamento amanhã/);
});
