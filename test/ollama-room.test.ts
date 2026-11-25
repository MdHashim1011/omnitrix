import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ollamaRoom } from '../src/drivers/ollama.js';
import { runOpenAI } from '../src/drivers/openai.js';
import { DriverError } from '../src/types.js';
import { account } from './helpers.js';

const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

interface Fake {
  maxContext?: number;
  loaded?: number;
  /** how many prompt tokens the fake says it read; all of them by default */
  read?: (sentChars: number) => number;
  /** milliseconds /api/show waits before it answers */
  showDelay?: number;
}

/** A fake Ollama: the OpenAI-style endpoint, the native chat, /api/show and /api/ps. */
async function ollama(fake: Fake = {}) {
  const calls: { path: string; body: any; auth?: string }[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      calls.push({ path: req.url ?? '', body, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining-requests': '41' });
      const chars = JSON.stringify(body?.messages ?? '').length;
      const read = fake.read ? fake.read(chars) : Math.round(chars / 4);
      if (req.url === '/api/show') return void setTimeout(() => res.end(JSON.stringify({ model_info: fake.maxContext ? { 'llama.context_length': fake.maxContext } : {} })), fake.showDelay ?? 0);
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: fake.loaded ? [{ name: 'llama3.2:3b', context_length: fake.loaded }] : [] }));
      if (req.url === '/api/chat') return res.end(JSON.stringify({ message: { role: 'assistant', content: '<think>hmm</think>PELICAN' }, done: true, prompt_eval_count: read, eval_count: 3 }));
      if (req.url === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: 'short answer' } }], usage: { prompt_tokens: read, completion_tokens: 2 } }));
      res.end('{}');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, calls };
}

const local = (base: string) => account({ id: 'ollama', provider: 'ollama', driver: 'openai', baseUrl: `${base}/v1`, local: true });
const long = 'Find the secret word. ' + 'filler text here. '.repeat(1200) + 'The secret word is PELICAN.';

describe('Ollama gets the working size a prompt needs', () => {
  it('chooses a size from the need, the model limit and what is loaded', () => {
    expect(ollamaRoom(4096)).toBeUndefined();
    expect(ollamaRoom(4097)).toBe(8192);
    expect(ollamaRoom(9000)).toBe(16384);
    expect(ollamaRoom(200_000)).toBe(32768);
    expect(ollamaRoom(9000, 8192)).toBe(8192);
    expect(ollamaRoom(9000, undefined, 65536)).toBe(65536);
    expect(ollamaRoom(9000, 32768, 65536)).toBe(32768);
  });

  it('keeps the usual endpoint for a short prompt', async () => {
    const f = await ollama({ maxContext: 131072 });
    const r = await runOpenAI({ account: local(f.base), model: 'llama3.2:3b', prompt: 'hi', timeoutMs: 5000, maxOutputTokens: 4000 });
    expect(r.text).toBe('short answer');
    expect(f.calls.map((c) => c.path)).toEqual(['/v1/chat/completions']);
  });

  it('asks the native endpoint for enough room for a long prompt and reads the whole answer', async () => {
    const f = await ollama({ maxContext: 131072 });
    const r = await runOpenAI({ account: local(f.base), model: 'llama3.2:3b', system: 'be brief', prompt: long, timeoutMs: 5000, maxOutputTokens: 16000 });
    expect(r.text).toBe('PELICAN');
    expect(r.outputTokens).toBe(3);
    expect(r.inputTokens).toBeGreaterThan(5000);
    const chat = f.calls.find((c) => c.path === '/api/chat')!;
    expect(chat.body.options.num_ctx).toBe(16384);
    expect(chat.body.options.num_predict).toBe(16000);
    expect(chat.body.stream).toBe(false);
    expect(chat.body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(chat.body.messages[1].content).toBe(long);
    expect(f.calls.some((c) => c.path === '/v1/chat/completions')).toBe(false);
  });

  it("stays within the model's own limit", async () => {
    const f = await ollama({ maxContext: 8192 });
    await runOpenAI({ account: local(f.base), model: 'llama3.2:3b', prompt: long, timeoutMs: 5000 });
    expect(f.calls.find((c) => c.path === '/api/chat')!.body.options.num_ctx).toBe(8192);
  });

  it('does not shrink a larger size that is already loaded, which would reload the model', async () => {
    const f = await ollama({ maxContext: 131072, loaded: 65536 });
    await runOpenAI({ account: local(f.base), model: 'llama3.2:3b', prompt: long, timeoutMs: 5000 });
    expect(f.calls.find((c) => c.path === '/api/chat')!.body.options.num_ctx).toBe(65536);
  });

  it('sends pictures in the native form', async () => {
    const f = await ollama({ maxContext: 131072 });
    await runOpenAI({ account: local(f.base), model: 'llama3.2:3b', prompt: long, timeoutMs: 5000, images: [{ mime: 'image/png', data: 'AAAA' }] });
    expect(f.calls.find((c) => c.path === '/api/chat')!.body.messages.at(-1).images).toEqual(['AAAA']);
  });

  it('still refuses an answer to a prompt that was cut, and remembers what the model really held', async () => {
    // an Ollama that ignores the size asked for: what arrived is the limit
    const f = await ollama({ maxContext: 8192, read: () => 2050 });
    const err = await runOpenAI({ account: local(f.base), model: 'llama3.2:3b', prompt: long, timeoutMs: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.kind).toBe('too_long');
    expect(err.readTokens).toBe(2050);
    expect(err.message).toMatch(/room for 8,192/);
    expect(err.message).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    // and when Ollama says it loaded the model with less room, that size is the limit
    const g = await ollama({ maxContext: 8192, loaded: 4096, read: () => 2050 });
    const again = await runOpenAI({ account: local(g.base), model: 'llama3.2:3b', prompt: long, timeoutMs: 5000 }).catch((e) => e);
    expect(again.readTokens).toBe(4096);
  });

  it('refuses a prompt larger than the model can hold before sending it', async () => {
    const f = await ollama({ maxContext: 4096 });
    const err = await runOpenAI({ account: local(f.base), model: 'llama3.2:3b', prompt: long, timeoutMs: 5000 }).catch((e) => e);
    expect(err.kind).toBe('too_long');
    expect(err.readTokens).toBe(4096);
    expect(f.calls.some((c) => c.path === '/api/chat')).toBe(false);
  });

  it('sends the account key to every Ollama endpoint, as a proxy in front of it may ask for', async () => {
    process.env.OMNITRIX_TEST_OLLAMA_KEY = 'proxy-key';
    try {
      const f = await ollama({ maxContext: 131072 });
      await runOpenAI({ account: { ...local(f.base), apiKey: 'env:OMNITRIX_TEST_OLLAMA_KEY' }, model: 'llama3.2:3b', prompt: long, timeoutMs: 5000 });
      expect(f.calls.map((c) => [c.path, c.auth])).toEqual([
        ['/api/show', 'Bearer proxy-key'],
        ['/api/ps', 'Bearer proxy-key'],
        ['/api/chat', 'Bearer proxy-key'],
      ]);
    } finally {
      delete process.env.OMNITRIX_TEST_OLLAMA_KEY;
    }
  });

  it('keeps the effort Claude asked for and the rate headers', async () => {
    const f = await ollama({ maxContext: 131072 });
    const r = await runOpenAI({ account: local(f.base), model: 'llama3.2:3b', prompt: long, timeoutMs: 5000, effort: 'high' });
    expect(f.calls.find((c) => c.path === '/api/chat')!.body.think).toBe('high');
    expect(r.rate?.remainingRequests).toBe(41);
  });

  it('stops at once when the job is cancelled while omnitrix asks the model size', async () => {
    const f = await ollama({ maxContext: 131072, showDelay: 3000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const started = Date.now();
    const err = await runOpenAI({ account: local(f.base), model: 'other:7b', prompt: long, timeoutMs: 5000, signal: ctrl.signal }).catch((e) => e);
    expect(err.kind).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(f.calls.some((c) => c.path === '/api/chat')).toBe(false);
  });

  it('asks the model size again after a while, since a model can be replaced under the same name', async () => {
    const f = await ollama({ maxContext: 8192 });
    const req = { account: local(f.base), model: 'swap:1b', prompt: long, timeoutMs: 5000 };
    await runOpenAI(req);
    await runOpenAI(req);
    expect(f.calls.filter((c) => c.path === '/api/show')).toHaveLength(1);
    const later = Date.now() + 11 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await runOpenAI(req);
    } finally {
      vi.restoreAllMocks();
    }
    expect(f.calls.filter((c) => c.path === '/api/show')).toHaveLength(2);
  });

  it('leaves other providers on the usual endpoint', async () => {
    const f = await ollama({ maxContext: 131072 });
    const other = account({ id: 'lm', provider: 'lmstudio', driver: 'openai', baseUrl: `${f.base}/v1`, local: true });
    await runOpenAI({ account: other, model: 'llama3.2:3b', prompt: long, timeoutMs: 5000 }).catch(() => undefined);
    expect(f.calls.map((c) => c.path)).toEqual(['/v1/chat/completions']);
  });
});
