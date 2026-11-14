import { beforeEach, describe, expect, it } from 'vitest';
import { classifyCliError } from '../src/drivers/cli.js';
import { retryAfterMs } from '../src/drivers/http.js';
import { runOpenAI } from '../src/drivers/openai.js';
import { makeModel } from '../src/models.js';
import { getProvider } from '../src/providers.js';
import { route } from '../src/router.js';
import { defaultSettings, redact, resolveKey, setSecret } from '../src/store.js';
import { account, tempHome } from './helpers.js';

beforeEach(() => {
  tempHome();
});

describe('waiting times from providers', () => {
  it('never waits longer than a day, whatever Retry-After says', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '99999999' }))).toBe(24 * 3600_000);
    expect(retryAfterMs(new Headers({ 'retry-after': '30' }))).toBe(30_000);
  });
});

describe('agent CLI errors', () => {
  it('tells a rate limit from a used-up plan, and does not read numbers inside other numbers', () => {
    expect(classifyCliError('Rate limit exceeded, try again in 20 seconds')).toBe('rate_limit');
    expect(classifyCliError('You have hit your usage limit for this plan')).toBe('quota');
    expect(classifyCliError('request 14013 failed to parse')).toBe('unknown');
    expect(classifyCliError('wrote 4290 bytes then stopped')).toBe('unknown');
    expect(classifyCliError('HTTP 401 Unauthorized')).toBe('auth');
  });
});

describe('hiding keys in messages', () => {
  it('hides Google and Fireworks keys and every configured key, and leaves ordinary words alone', () => {
    expect(redact('key AIzaSyA1234567890abcdefghijklmnopqrstu end')).not.toContain('1234567890abcdef');
    expect(redact('key fw_abcdefghijklmnop12345 end')).not.toContain('abcdefghijklmnop');
    expect(redact('the task-abcdefghijklmnop went fine')).toBe('the task-abcdefghijklmnop went fine');
    setSecret('a', 'plainvalue-without-prefix-42');
    expect(resolveKey(account({ id: 'a', apiKey: 'secret' }))).toBe('plainvalue-without-prefix-42');
    expect(redact('server said: bad key plainvalue-without-prefix-42')).not.toContain('plainvalue-without-prefix-42');
  });

  it('never repeats a key typed straight into the configuration', async () => {
    const err = await runOpenAI({ account: account({ id: 'a', apiKey: 'rawvaluetypedbymistake99' }), model: 'test-model', prompt: 'p', timeoutMs: 1000 }).catch((e: Error) => e);
    expect(String(err)).toMatch(/no API key/);
    expect(String(err)).not.toContain('rawvaluetypedbymistake99');
  });
});

describe('secret tasks', () => {
  const ctx = (accounts: ReturnType<typeof account>[]) => ({ config: { version: 1, accounts, settings: { ...defaultSettings } }, usage: {}, health: {}, running: {}, stats: {} });

  it('go only to models that really run on this computer', () => {
    const remote = account({ id: 'moved', local: true, baseUrl: 'https://ollama.example.com/v1', models: [makeModel('llama3')] });
    const cloud = account({ id: 'ol', local: true, baseUrl: 'http://localhost:11434/v1', models: [makeModel('gpt-oss:120b-cloud'), makeModel('llama3')] });
    const { candidates } = route({ title: 't', type: 'reasoning', prompt: 'p', privacy: 'secret' }, ctx([remote, cloud]) as never);
    expect(candidates.map((c) => `${c.accountId}/${c.model}`)).toEqual(['ol/llama3']);
  });

  it('Gemini CLI uses the same API terms as the Gemini API, which may train on prompts', () => {
    expect(getProvider('gemini-cli')?.trainsOnData).toBe(getProvider('gemini')?.trainsOnData);
  });
});
