import { describe, expect, it } from 'vitest';
import { envForChild } from './env';

describe('envForChild', () => {
  it('removes Anthropic credentials', () => {
    const env = envForChild({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_MODEL: 'kept',
      PATH: '/usr/bin',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env.ANTHROPIC_MODEL).toBe('kept');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('sets terminal identity variables', () => {
    const env = envForChild({ TERM: 'dumb', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3' });
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.ACODE).toBe('1');
    expect(env.TERM_PROGRAM).toBe('ARcode');
    expect(env).not.toHaveProperty('TERM_PROGRAM_VERSION');
  });

  it('drops session markers inherited from a parent terminal or Claude Code session', () => {
    const env = envForChild({
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      TERMINAL_EMULATOR: 'JetBrains-JediTerm',
      CLAUDE_CONFIG_DIR: '/kept',
    });
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(env).not.toHaveProperty('TERMINAL_EMULATOR');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/kept');
  });

  it('fills LANG only when it is empty', () => {
    expect(envForChild({}).LANG).toBe('en_US.UTF-8');
    expect(envForChild({ LANG: '' }).LANG).toBe('en_US.UTF-8');
    expect(envForChild({ LANG: 'de_DE.UTF-8' }).LANG).toBe('de_DE.UTF-8');
  });

  it('removes provider switches, bearer tokens and parent session variables', () => {
    const env = envForChild({
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      ANTHROPIC_BASE_URL: 'http://x',
      ANTHROPIC_UNIX_SOCKET: '/s',
      ANTHROPIC_CUSTOM_HEADERS: 'h',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_USE_MANTLE: '1',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
      CLAUDE_CODE_USE_GATEWAY: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'b',
      AI_AGENT: 'x',
      CLAUDE_CODE_SOMETHING_NEW: '1',
      CLAUDE_CODE_SSE_PORT: '1234',
    });
    for (const key of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_UNIX_SOCKET',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_MANTLE',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_GATEWAY',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AI_AGENT',
      'CLAUDE_CODE_SOMETHING_NEW',
      'CLAUDE_CODE_SSE_PORT',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('adds ARcode markers, the project folder and extra env (which wins)', () => {
    const env = envForChild(
      { CLAUDE_CODE_SSE_PORT: '1' },
      { project: '/work/app', extraEnv: { CLAUDE_CODE_SSE_PORT: '4242', 'bad key': 'x' } },
    );
    expect(env.ARCODE_PROJECT).toBe('/work/app');
    expect(env.CLAUDE_CODE_SSE_PORT).toBe('4242');
    expect(env.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL).toBe('1');
    expect(env).not.toHaveProperty('bad key');
  });

  it('drops undefined values and does not mutate the source', () => {
    const source = { A: 'a', B: undefined, ANTHROPIC_API_KEY: 'x' };
    const env = envForChild(source);
    expect(env).not.toHaveProperty('B');
    expect(source.ANTHROPIC_API_KEY).toBe('x');
  });
});
