import { beforeEach, describe, expect, it } from 'vitest';
import { classifyCliError } from '../src/drivers/cli.js';
import { retryAfterMs } from '../src/drivers/http.js';
import { runOpenAI, withoutThinking } from '../src/drivers/openai.js';
import { makeModel } from '../src/models.js';
import { getProvider } from '../src/providers.js';
import { route } from '../src/router.js';
import { defaultSettings, redact, resolveKey, setSecret } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome } from './helpers.js';

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

describe('thinking at the start of an answer', () => {
  it('removes a thought block that a model puts before its answer', () => {
    // seen in real use: Gemma 4 on the Gemini API answered "<thought>...</thought>Red, Blue, Yellow"
    expect(withoutThinking('<thought>* Input: name colours.\n* Red, Blue, Yellow</thought>Red, Blue, Yellow')).toBe('Red, Blue, Yellow');
    expect(withoutThinking('  <think>\nhmm\n</think>\n\nThe answer is 4.')).toBe('The answer is 4.');
  });

  it('keeps everything else as it is', () => {
    // a block later in the answer is part of the answer
    expect(withoutThinking('Use <think> tags like <think>this</think>.')).toBe('Use <think> tags like <think>this</think>.');
    // an unclosed block may be cut off, and an answer that is only thinking is still better than nothing
    expect(withoutThinking('<thought>still going')).toBe('<thought>still going');
    expect(withoutThinking('<thought>only this</thought>')).toBe('<thought>only this</thought>');
  });

  it('gives the worker answer without the block', async () => {
    const p = await mockProvider(() => ({ json: chatReply('<thought>plan</thought>Red, Blue, Yellow') }));
    try {
      const r = await runOpenAI({ account: account({ id: 'a', baseUrl: p.url, local: true }), model: 'test-model', prompt: 'p', timeoutMs: 5000 });
      expect(r.text).toBe('Red, Blue, Yellow');
    } finally {
      await p.close();
    }
  });
});

describe('error messages from providers', () => {
  it('shows the sentence from a JSON error on one line, and keeps the kind of error', async () => {
    // seen in real use: Gemini answered 503 with [{ "error": { "code": 503, "message": "...", "status": "UNAVAILABLE" } }]
    const busy = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.';
    const p = await mockProvider(() => ({ status: 503, json: [{ error: { code: 503, message: busy, status: 'UNAVAILABLE' } }] }));
    try {
      const err: any = await runOpenAI({ account: account({ id: 'a', baseUrl: p.url, local: true }), model: 'test-model', prompt: 'p', timeoutMs: 5000 }).catch((e) => e);
      expect(err.message).toBe(`HTTP 503: ${busy}`);
      expect(err.kind).toBe('server');
    } finally {
      await p.close();
    }
  });

  it('keeps a body that is not a JSON error, on one line', async () => {
    const { errorMessage } = await import('../src/drivers/http.js');
    expect(errorMessage('<html>\n  Bad Gateway\n</html>')).toBe('<html> Bad Gateway </html>');
    expect(errorMessage('{"message":"model not found"}')).toBe('model not found');
    expect(errorMessage('{"error":"invalid key"}')).toBe('invalid key');
  });
});
