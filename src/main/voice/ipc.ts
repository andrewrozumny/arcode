import { join } from 'node:path';
import os from 'node:os';
import { app, systemPreferences } from 'electron';
import type { IpcMain } from 'electron';
import { isRecord } from '@shared/guards';
import { discussionModelChoice, TTS_ENGINES, VoiceChannel } from '@shared/voice';
import type { SpeechResult, TranscribeResult, TtsEngine, TtsInfo } from '@shared/voice';
import { projectRoot, text } from '../ipcArgs';
import { readFeed } from '../claude/feed';
import { isSessionId } from '../claude/transcripts';
import { Discussion } from './discussion';
import { DiscussionHistory, logRecord } from './history';
import { SessionContext } from './sessionContext';
import { SessionMcpServer } from './sessionMcp';
import { DEFAULT_VOICE, ElevenLabs } from './elevenlabs';
import { DEFAULT_SPEAKER, Silero, SILERO_SCRIPT, SILERO_VOICES, sileroPython } from './silero';
import { speechText, speechVoice, synthesize } from './speech';
import { transcribeWav, wavBytes } from './transcribe';

function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name);
}

/** A discuss request from the renderer, checked; the message text is checked by Discussion.send. */
export function discussRequest(value: unknown): { root: unknown; text: string; model: ReturnType<typeof discussionModelChoice>; sessionId: string | null; status: string | null } {
  if (!isRecord(value)) throw new Error('Invalid discussion request');
  return {
    root: value.projectRoot,
    text: text(value.text, 'message'),
    model: discussionModelChoice(value.model),
    sessionId: isSessionId(value.sessionId) ? value.sessionId : null,
    status: typeof value.status === 'string' ? value.status.slice(0, 16) : null,
  };
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

  ipcMain.handle(VoiceChannel.TtsUsage, () => elevenLabs.usage());

  // One discussion per window; its answer goes back to that window only. Each one has its session
  // context (the brief) and a token for the lookup server, which reads that window's session.
  const home = os.homedir();
  const lookup = new SessionMcpServer();
  const discussions = new Map<number, { discussion: Discussion; context: SessionContext; token: string | null }>();
  ipcMain.handle(VoiceChannel.Discuss, async (event, raw: unknown): Promise<void> => {
    const request = discussRequest(raw);
    const root = await projectRoot(request.root);
    const sender = event.sender;
    let entry = discussions.get(sender.id);
    if (!entry) {
      const context = new SessionContext((feed) => readFeed(feed, home), root);
      let token: string | null = null;
      let url: string | null = null;
      try {
        const port = await lookup.start();
        token = lookup.register({ home, sessionId: () => context.current, brief: () => context.currentBrief() });
        url = `http://127.0.0.1:${port}/mcp`;
      } catch (error) {
        console.warn('[arcode] session lookup server not started:', error instanceof Error ? error.message : error);
      }
      const discussion = new Discussion(
        root,
        (update) => {
          if (!sender.isDestroyed()) sender.send(VoiceChannel.DiscussionEvent, update);
        },
        { server: token && url ? { url, token } : null, onCompacted: () => context.needFull() },
      );
      entry = { discussion, context, token };
      discussions.set(sender.id, entry);
      sender.once('destroyed', () => {
        const gone = discussions.get(sender.id);
        gone?.discussion.reset();
        if (gone?.token) lookup.unregister(gone.token);
        discussions.delete(sender.id);
      });
    }
    const { context } = entry;
    await entry.discussion.send(request.text, request.model, (fresh) => context.brief(request.sessionId, request.status, fresh));
  });
  ipcMain.on(VoiceChannel.DiscussReset, (event) => {
    const entry = discussions.get(event.sender.id);
    entry?.discussion.reset();
    entry?.context.needFull();
  });

  // History files, one writer per project so records of a conversation stay in order.
  const histories = new Map<string, DiscussionHistory>();
  ipcMain.handle(VoiceChannel.DiscussLog, async (_event, rawRoot: unknown, rawRecord: unknown): Promise<boolean> => {
    try {
      const root = await projectRoot(rawRoot);
      const record = logRecord(rawRecord);
      let history = histories.get(root);
      if (!history) {
        history = new DiscussionHistory(root);
        histories.set(root, history);
      }
      await history.append(record);
      return true;
    } catch (error) {
      console.warn('[arcode] discussion history not written:', error instanceof Error ? error.message : error);
      return false;
    }
  });
  app.on('will-quit', () => {
    for (const entry of discussions.values()) entry.discussion.reset();
    lookup.stop();
  });

  ipcMain.handle(VoiceChannel.RequestMic, async (): Promise<boolean> => {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });
}
