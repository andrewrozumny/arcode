import { join } from 'node:path';
import { app, systemPreferences } from 'electron';
import type { IpcMain } from 'electron';
import { isRecord } from '@shared/guards';
import { TTS_ENGINES, VoiceChannel } from '@shared/voice';
import type { SpeechResult, TranscribeResult, TtsEngine, TtsInfo } from '@shared/voice';
import { DEFAULT_VOICE, ElevenLabs } from './elevenlabs';
import { DEFAULT_SPEAKER, Silero, SILERO_SCRIPT, SILERO_VOICES, sileroPython } from './silero';
import { speechText, speechVoice, synthesize } from './speech';
import { transcribeWav, wavBytes } from './transcribe';

function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name);
}

export function speakRequest(value: unknown): { text: string; engine: TtsEngine; voice: string | undefined } {
  if (!isRecord(value)) throw new Error('Invalid speech request');
  const engine = TTS_ENGINES.find((e) => e === value.engine);
  if (!engine) throw new Error('Unknown speech engine');
  return { text: speechText(value.text), engine, voice: typeof value.voice === 'string' ? value.voice.slice(0, 64) : undefined };
}

/** Registers the voice handlers: dictation (whisper.cpp, one at a time) and reading answers aloud. */
export function registerVoiceIpc(ipcMain: IpcMain): void {
  let queue: Promise<unknown> = Promise.resolve();
  const elevenLabs = new ElevenLabs();
  const silero = new Silero(resourcePath(SILERO_SCRIPT), sileroPython(process.env));
  app.on('will-quit', () => silero.stop());

  ipcMain.handle(VoiceChannel.Transcribe, (_event, bytes: unknown): Promise<TranscribeResult> => {
    const wav = wavBytes(bytes);
    const next = queue.then(() => transcribeWav(wav, { userData: app.getPath('userData') }));
    queue = next.catch(() => undefined);
    return next;
  });

  ipcMain.handle(VoiceChannel.Speak, (_event, raw: unknown): Promise<SpeechResult> => {
    const request = speakRequest(raw);
    if (request.engine === 'elevenlabs') return elevenLabs.speak(request.text, request.voice);
    if (request.engine === 'silero') return silero.speak(request.text, request.voice);
    return synthesize(request.text);
  });

  ipcMain.handle(VoiceChannel.TtsInfo, async (): Promise<TtsInfo> => {
    const [key, sileroReady] = await Promise.all([elevenLabs.key(), silero.available()]);
    const system = speechVoice(process.env) ?? 'System voice';
    return {
      elevenlabs: key
        ? { available: true, voices: await elevenLabs.voices(), defaultVoice: DEFAULT_VOICE }
        : {
            available: false,
            reason: 'Add an ElevenLabs API key to the Keychain: security add-generic-password -U -s "ARcode ElevenLabs" -a api-key -w',
            voices: [],
            defaultVoice: DEFAULT_VOICE,
          },
      silero: sileroReady
        ? { available: true, voices: [...SILERO_VOICES], defaultVoice: DEFAULT_SPEAKER }
        : {
            available: false,
            reason: 'Install Silero into ~/models/silero/.venv (pip install silero torch scipy omegaconf) or set ARCODE_SILERO_PYTHON',
            voices: [...SILERO_VOICES],
            defaultVoice: DEFAULT_SPEAKER,
          },
      system: { available: process.platform === 'darwin', voices: [{ id: system, name: system, description: 'macOS voice' }], defaultVoice: system },
    };
  });

  ipcMain.handle(VoiceChannel.RequestMic, async (): Promise<boolean> => {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
}
