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
  discuss: (request) => ipcRenderer.invoke(VoiceChannel.Discuss, request),
  discussReset: () => ipcRenderer.send(VoiceChannel.DiscussReset),
  discussLog: (projectRoot, record) => ipcRenderer.invoke(VoiceChannel.DiscussLog, projectRoot, record),
  onDiscussion: (listener) => subscribe<[DiscussionEvent]>(VoiceChannel.DiscussionEvent, listener),
};
