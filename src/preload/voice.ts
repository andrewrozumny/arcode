import { ipcRenderer } from 'electron';
import { VoiceChannel } from '@shared/voice';
import type { DiscussionEvent, VoiceApi } from '@shared/voice';
import { subscribe } from './subscribe';

/** Exposed as `window.acode.voice` from the preload entry. */
export const voiceApi: VoiceApi = {
  transcribe: (bytes) => ipcRenderer.invoke(VoiceChannel.Transcribe, bytes),
  requestMic: () => ipcRenderer.invoke(VoiceChannel.RequestMic),
  speak: (request) => ipcRenderer.invoke(VoiceChannel.Speak, request),
  ttsInfo: () => ipcRenderer.invoke(VoiceChannel.TtsInfo),
  ttsUsage: () => ipcRenderer.invoke(VoiceChannel.TtsUsage),
  discuss: (projectRoot, text, model) => ipcRenderer.invoke(VoiceChannel.Discuss, projectRoot, text, model),
  discussReset: () => ipcRenderer.send(VoiceChannel.DiscussReset),
  onDiscussion: (listener) => subscribe<[DiscussionEvent]>(VoiceChannel.DiscussionEvent, listener),
};
