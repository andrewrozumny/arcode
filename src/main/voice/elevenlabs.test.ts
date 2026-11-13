import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, DEFAULT_VOICE, ElevenLabs, modelId, parseUsage, parseVoices, voiceId } from './elevenlabs';
import type { Fetch } from './elevenlabs';

const response = (status: number, body: unknown, bytes?: Uint8Array): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve((bytes ?? new Uint8Array()).buffer),
  }) as unknown as Response;

describe('ElevenLabs helpers', () => {
  it('validates voice and model ids', () => {
    expect(voiceId('gJEfHTTiifXEDmO687lC')).toBe('gJEfHTTiifXEDmO687lC');
    expect(voiceId('../x')).toBe(DEFAULT_VOICE);
    expect(modelId({})).toBe(DEFAULT_MODEL);
    expect(modelId({ ARCODE_ELEVENLABS_MODEL: 'eleven_flash_v2_5' })).toBe('eleven_flash_v2_5');
  });

  it('reads the account voices', () => {
    expect(parseVoices({ voices: [{ voice_id: 'zzzzzzzzzz', name: 'Zed', labels: { gender: 'male' } }, { voice_id: 'bad id', name: 'x' }] })).toEqual([
      { id: 'zzzzzzzzzz', name: 'Zed', description: 'male' },
    ]);
  });
});

describe('parseUsage', () => {
  it('reads used and limit characters and the reset time', () => {
    expect(parseUsage({ tier: 'starter', character_count: 1559, character_limit: 40000, next_character_count_reset_unix: 1797119445 })).toEqual({
      used: 1559,
      limit: 40000,
      resetsAt: 1797119445000,
      tier: 'starter',
    });
    expect(parseUsage({ character_count: 1, character_limit: 0 })).toBeNull();
    expect(parseUsage(null)).toBeNull();
  });
});

describe('ElevenLabs', () => {
  it('reads the subscription only with a key', async () => {
    const withKey = new ElevenLabs({}, () => Promise.resolve('k'), () => Promise.resolve(response(200, { character_count: 10, character_limit: 100 })));
    expect(await withKey.usage()).toMatchObject({ used: 10, limit: 100 });
    const keyless = new ElevenLabs({}, () => Promise.resolve(null), () => Promise.reject(new Error('no call expected')));
    expect(await keyless.usage()).toBeNull();
  });

  it('speaks with the key from the store and the chosen voice', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: Fetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response(200, null, new Uint8Array([1, 2, 3])));
    };
    const client = new ElevenLabs({}, () => Promise.resolve('secret-key'), fetcher);
    const result = await client.speak('Привет', 'gJEfHTTiifXEDmO687lC');
    expect(result).toEqual({ ok: true, audio: new Uint8Array([1, 2, 3]) });
    expect(calls[0]?.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/gJEfHTTiifXEDmO687lC?output_format=mp3_44100_128');
    expect((calls[0]?.init.headers as Record<string, string>)['xi-api-key']).toBe('secret-key');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: 'Привет', model_id: DEFAULT_MODEL });
  });

  it('reports API errors and a missing key', async () => {
    const failing = new ElevenLabs({}, () => Promise.resolve('k'), () => Promise.resolve(response(401, { detail: { message: 'Invalid API key' } })));
    expect(await failing.speak('x', undefined)).toEqual({ ok: false, message: 'ElevenLabs: Invalid API key' });
    const keyless = new ElevenLabs({}, () => Promise.resolve(null), () => Promise.reject(new Error('no call expected')));
    const result = await keyless.speak('x', undefined);
    expect(result.ok).toBe(false);
  });

  it('lists the default voice first even when it is not in the account', async () => {
    const client = new ElevenLabs({}, () => Promise.resolve('k'), () => Promise.resolve(response(200, { voices: [{ voice_id: 'aaaaaaaaaa', name: 'Anna' }] })));
    const voices = await client.voices();
    expect(voices.map((v) => v.id)).toEqual([DEFAULT_VOICE, 'aaaaaaaaaa']);
  });

  it('prefers ELEVENLABS_API_KEY over the Keychain', async () => {
    const client = new ElevenLabs({ ELEVENLABS_API_KEY: 'from-env' }, () => Promise.resolve('from-keychain'));
    expect(await client.key()).toBe('from-env');
  });
});
