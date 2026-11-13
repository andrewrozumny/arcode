import { ipcRenderer } from 'electron';
import { VoiceChannel } from '@shared/voice';
import type { VoiceApi } from '@shared/voice';

/** Exposed as `window.acode.voice` from the preload entry. */
export const voiceApi: VoiceApi = {
  transcribe: (bytes) => ipcRenderer.invoke(VoiceChannel.Transcribe, bytes),
  requestMic: () => ipcRenderer.invoke(VoiceChannel.RequestMic),
  speak: (request) => ipcRenderer.invoke(VoiceChannel.Speak, request),
  ttsInfo: () => ipcRenderer.invoke(VoiceChannel.TtsInfo),
  ttsUsage: () => ipcRenderer.invoke(VoiceChannel.TtsUsage),
};
