'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('transyncAPI', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('transync:get-state'),
  listApps: () => ipcRenderer.invoke('transync:list-apps'),
  preloadWhisper: (modelId) => ipcRenderer.invoke('transync:preload-whisper', modelId),
  startSession: (config) => ipcRenderer.invoke('transync:start-session', config),
  pauseSession: (paused) => ipcRenderer.invoke('transync:pause-session', paused),
  stopSession: () => ipcRenderer.invoke('transync:stop-session'),
  sendMicPcm: (int16Samples) => ipcRenderer.send('transync:mic-pcm', int16Samples),
  submitRecognizedText: (payload) => ipcRenderer.invoke('transync:submit-recognized-text', payload),
  runDemoTest: () => ipcRenderer.invoke('transync:run-demo-test'),
  quickTranslate: (payload) => ipcRenderer.invoke('transync:quick-translate', payload),
  updateConfig: (partialConfig) => ipcRenderer.invoke('transync:update-config', partialConfig),
  clearEntries: () => ipcRenderer.invoke('transync:clear-entries'),
  togglePip: (visible) => ipcRenderer.invoke('transync:toggle-pip', visible),
  generateSummary: () => ipcRenderer.invoke('transync:generate-summary'),
  exportTranscript: (opts) => ipcRenderer.invoke('transync:export-transcript', opts),
  openExternal: (url) => ipcRenderer.invoke('transync:open-external', url),

  onUtterance: (cb) => subscribe('transync:utterance', cb),
  onRemovePlaceholder: (cb) => subscribe('transync:remove-placeholder', cb),
  onAudioLevel: (cb) => subscribe('transync:audio-level', cb),
  onModelStatus: (cb) => subscribe('transync:model-status', cb),
  onLoopbackStatus: (cb) => subscribe('transync:loopback-status', cb),
  onSessionState: (cb) => subscribe('transync:session-state', cb),
  onPipVisibility: (cb) => subscribe('transync:pip-visibility', cb),
  onEntriesCleared: (cb) => subscribe('transync:entries-cleared', cb),
  onInitState: (cb) => subscribe('transync:init-state', cb)
});
