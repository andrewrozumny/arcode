import { app, systemPreferences } from 'electron';
import type { IpcMain } from 'electron';
import { VoiceChannel } from '@shared/voice';
import type { TranscribeResult } from '@shared/voice';
import { transcribeWav, wavBytes } from './transcribe';

/** Registers the voice input handlers. Transcriptions run one at a time (whisper uses the whole GPU). */
export function registerVoiceIpc(ipcMain: IpcMain): void {
  let queue: Promise<unknown> = Promise.resolve();

  ipcMain.handle(VoiceChannel.Transcribe, (_event, bytes: unknown): Promise<TranscribeResult> => {
    const wav = wavBytes(bytes);
    const next = queue.then(() => transcribeWav(wav, { userData: app.getPath('userData') }));
    queue = next.catch(() => undefined);
    return next;
  });

  ipcMain.handle(VoiceChannel.RequestMic, async (): Promise<boolean> => {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
}
