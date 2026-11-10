'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOOPBACK_BINARY_NAME = 'transync-win-process-loopback-helper.exe';
const PIP_ZORDER_BINARY_NAME = 'transync-win-pip-z-order-helper.exe';
const TARGET_SAMPLE_RATE = 16000;

/**
 * Localiza um binário helper nativo do Windows priorizando a pasta local do projeto
 * e fazendo fallback para a instalação oficial em C:\Program Files\Transync AI.
 */
function resolveNativeHelperPath(binaryName) {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'resources', 'win-native-helpers', binaryName),
    process.resourcesPath
      ? path.join(process.resourcesPath, 'win-native-helpers', binaryName)
      : null,
    path.join('C:\\Program Files\\Transync AI\\resources\\win-native-helpers', binaryName)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignora erros de permissão de leitura e tenta o próximo candidato
    }
  }
  return null;
}

/**
 * Converte um buffer Int16Array de qualquer taxa de amostragem para 16000 Hz mono.
 */
function resampleInt16To16kHz(samples, sampleRate, channels = 1) {
  let monoSamples = samples;
  if (channels > 1) {
    const frameCount = Math.floor(samples.length / channels);
    monoSamples = new Int16Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch++) {
        sum += samples[i * channels + ch];
      }
      monoSamples[i] = Math.round(sum / channels);
    }
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || Math.round(sampleRate) === TARGET_SAMPLE_RATE) {
    return monoSamples;
  }

  const ratio = sampleRate / TARGET_SAMPLE_RATE;
  const targetLength = Math.max(1, Math.round(monoSamples.length / ratio));
  const resampled = new Int16Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio;
    const leftIdx = Math.floor(srcPos);
    const rightIdx = Math.min(monoSamples.length - 1, leftIdx + 1);
    const frac = srcPos - leftIdx;
    const leftVal = monoSamples[leftIdx] || 0;
    const rightVal = monoSamples[rightIdx] ?? leftVal;
    resampled[i] = Math.round(leftVal + (rightVal - leftVal) * frac);
  }
  return resampled;
}

/**
 * Decodifica uma string Base64 de PCM Int16 Little-Endian para Int16Array.
 */
function decodeBase64PcmInt16(pcmBase64) {
  const buf = Buffer.from(pcmBase64, 'base64');
  const sampleCount = Math.floor(buf.byteLength / 2);
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = buf.readInt16LE(i * 2);
  }
  return out;
}

/**
 * Gerenciador do helper WASAPI Process Loopback (ActivateAudioInterfaceAsync)
 * que captura todo o áudio do sistema (Microsoft Teams, Zoom, navegador)
 * excluindo a árvore de processos do próprio aplicativo para evitar loop de eco.
 */
class WindowsSystemAudioLoopback extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stopping = false;
    this.readyState = null;
  }

  isAvailable() {
    return process.platform === 'win32' && Boolean(resolveNativeHelperPath(LOOPBACK_BINARY_NAME));
  }

  getHelperPath() {
    return resolveNativeHelperPath(LOOPBACK_BINARY_NAME);
  }

  async start(targetPid = process.pid) {
    if (process.platform !== 'win32') {
      throw new Error('Captura WASAPI Process Loopback disponível apenas no Windows.');
    }
    if (this.child && this.readyState) {
      return this.readyState;
    }
    if (this.child) {
      await this.stop();
    }

    const helperPath = this.getHelperPath();
    if (!helperPath) {
      throw new Error(`Helper nativo não encontrado (${LOOPBACK_BINARY_NAME}).`);
    }

    this.stopping = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.readyState = null;

    return new Promise((resolve, reject) => {
      const startTimeout = setTimeout(() => {
        this.stop().catch(() => {});
        reject(new Error('Timeout (10s) ao iniciar transync-win-process-loopback-helper.exe'));
      }, 10000);

      const child = spawn(
        helperPath,
        [
          'start',
          '--target-pid',
          String(targetPid),
          '--mode',
          'exclude-tree',
          '--chunk-frames',
          '1024'
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        }
      );

      child.stdin.end();
      this.child = child;

      child.stdout.on('data', (chunk) => {
        this.stdoutBuffer += chunk.toString('utf8');
        let newlineIdx = this.stdoutBuffer.indexOf('\n');
        while (newlineIdx >= 0) {
          const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
          if (line) {
            try {
              const payload = JSON.parse(line);
              if (payload.type === 'ready') {
                clearTimeout(startTimeout);
                this.readyState = {
                  started: true,
                  sampleRate: payload.sampleRate || TARGET_SAMPLE_RATE,
                  channels: payload.channels || 1,
                  targetProcessId: payload.targetProcessId || targetPid,
                  mode: payload.mode || 'exclude-target-process-tree',
                  helperPath
                };
                this.emit('ready', this.readyState);
                resolve(this.readyState);
              } else if (payload.pcmBase64) {
                const rawInt16 = decodeBase64PcmInt16(payload.pcmBase64);
                const pcm16k = resampleInt16To16kHz(
                  rawInt16,
                  payload.sampleRate || TARGET_SAMPLE_RATE,
                  payload.channels || 1
                );
                this.emit('pcm', {
                  sampleRate: TARGET_SAMPLE_RATE,
                  channels: 1,
                  frames: pcm16k.length,
                  sequence: payload.sequence ?? 0,
                  samples: pcm16k
                });
              }
            } catch (err) {
              this.emit('warn', new Error(`Falha ao parsear JSON do helper de loopback: ${err.message}`));
            }
          }
          newlineIdx = this.stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr.on('data', (chunk) => {
        this.stderrBuffer += chunk.toString('utf8');
      });

      child.once('error', (err) => {
        clearTimeout(startTimeout);
        this.child = null;
        this.readyState = null;
        this.emit('error', err);
        reject(err);
      });

      child.once('exit', (code, signal) => {
        clearTimeout(startTimeout);
        const wasStopping = this.stopping;
        const stderrMsg = this.stderrBuffer.trim();
        this.child = null;
        this.readyState = null;
        if (!wasStopping && code !== 0) {
          const exitErr = new Error(
            stderrMsg || `Loopback helper encerrou inesperadamente (code=${code}, signal=${signal})`
          );
          this.emit('stopped', { reason: 'error', message: exitErr.message, code, signal });
          reject(exitErr);
        } else {
          this.emit('stopped', { reason: wasStopping ? 'stopped' : 'exit', code, signal });
        }
      });
    });
  }

  async stop() {
    if (!this.child) {
      return;
    }
    this.stopping = true;
    const proc = this.child;
    this.child = null;
    this.readyState = null;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

/**
 * Gerencia o helper nativo transync-win-pip-z-order-helper.exe para manter
 * a janela PiP de legendas sempre acima do Microsoft Teams mesmo em tela cheia.
 */
class WindowsPipZOrderHelper {
  constructor() {
    this.child = null;
  }

  attach(browserWindow, ownerPid = process.pid) {
    this.detach();
    if (process.platform !== 'win32' || !browserWindow || browserWindow.isDestroyed()) {
      return false;
    }
    const helperPath = resolveNativeHelperPath(PIP_ZORDER_BINARY_NAME);
    if (!helperPath) {
      return false;
    }

    try {
      const handleBuf = browserWindow.getNativeWindowHandle();
      const hwnd =
        handleBuf.length >= 8 ? handleBuf.readBigUInt64LE(0) : BigInt(handleBuf.readUInt32LE(0));
      const proc = spawn(helperPath, [String(hwnd), String(ownerPid)], {
        stdio: 'ignore',
        windowsHide: true
      });
      this.child = proc;
      proc.once('error', () => {
        if (this.child === proc) this.child = null;
      });
      proc.once('exit', () => {
        if (this.child === proc) this.child = null;
      });
      return true;
    } catch {
      return false;
    }
  }

  detach() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // Ignora falha ao encerrar processo auxiliar
      }
      this.child = null;
    }
  }
}

module.exports = {
  WindowsSystemAudioLoopback,
  WindowsPipZOrderHelper,
  resolveNativeHelperPath,
  resampleInt16To16kHz,
  decodeBase64PcmInt16,
  TARGET_SAMPLE_RATE
};
