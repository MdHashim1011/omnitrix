import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyStatus, minuteLimit } from '../src/drivers/http.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { modelHealthKey } from '../src/router.js';
import { loadHealth, setSecret } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// From the owner's laptop on 2026-11-26: the failed attempts of a long run, one line each. The provider texts
// below are the ones in that export, with the organization ids removed.

const body = (message: string) => JSON.stringify({ error: { message } });

describe('what each refusal from that run means', () => {
  it('reads a plan or payment requirement as the whole account, and a paid model as that model only', () => {
    expect(classifyStatus(402, body('You need a subscription to access this API.'))).toBe('quota');
    expect(classifyStatus(402, body('A payment method is required. Add one at https://cloud.sambanova.ai/plans/billing to continue.'))).toBe('quota');
    expect(classifyStatus(402, body('This request requires more credits, or fewer max_tokens. You requested up to 16000 tokens, but can only afford 1000.'))).toBe('paid_model');
  });

  it("reads OpenRouter's upstream error on a free model as that model's problem, not the key's limit", () => {
    expect(classifyStatus(429, body('Provider returned error'))).toBe('server');
  });

  it('reads limits per minute as passing soon, and a request bigger than the output allowance as too long', () => {
    expect(classifyStatus(429, body('Requests per minute limit exceeded - too many requests sent.'))).toBe('rate_limit');
    expect(classifyStatus(429, body('Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Used 3393, Requested 4082. Please try again in 4.07s.'))).toBe('rate_limit');
    const otpm = 'Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 3753.';
    expect(classifyStatus(429, body(otpm))).toBe('too_long');
    expect(minuteLimit(body(otpm))).toEqual({ tokens: 1000, outputOnly: true });
  });

  it("reads Gemini's busy models as a passing fault of that model", () => {
    expect(classifyStatus(503, body('This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'))).toBe('server');
    expect(classifyStatus(404, body('This model models/gemini-2.5-flash-lite is no longer available to new users. Please update your code to use models/gemini-3.5-flash-lite.'))).toBe('model_gone');
  });
});

describe('how the pool reacts', () => {
  let closers: (() => Promise<void>)[] = [];
  beforeEach(() => {
    tempHome();
  });
  afterEach(async () => {
    for (const c of closers) await c();
    closers = [];
  });

  it('rests longer each time a limit per minute refuses again right after a short rest', async () => {
    const p = await mockProvider(() => ({ status: 429, headers: { 'retry-after': '1' }, json: { error: { message: 'Requests per minute limit exceeded - too many requests sent.' } } }));
    closers.push(p.close);
    setSecret('cerebras', 'sk-test-cerebras-00000000');
    writeConfig([account({ id: 'cerebras', baseUrl: p.url, apiKey: 'secret' })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p', privacy: 'public' }]);
    const rest = () => { const h = loadHealth().cerebras!; return h.until! - h.at!; };
    for (let i = 0; i < 80 && p.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    expect(Math.abs(rest() - 2000)).toBeLessThan(50);
    for (let i = 0; i < 120 && p.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    expect(p.calls.length).toBe(2);
    expect(Math.abs(rest() - 4000)).toBeLessThan(50);
    engine.cancel(job!.id);
  });

  it('keeps an account that needs a plan or payment out of use for a day, without trying its other models', async () => {
    const p = await mockProvider(() => ({ status: 402, json: { error: { message: 'You need a subscription to access this API.' } } }));
    closers.push(p.close);
    setSecret('mistral', 'sk-test-mistral-000000000');
    writeConfig([account({ id: 'mistral', baseUrl: p.url, apiKey: 'secret', models: [makeModel('mistral-small-latest'), makeModel('mistral-vibe-cli-fast')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p', privacy: 'public' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(p.calls.length).toBe(1);
    const h = loadHealth().mistral!;
    expect(h.state).toBe('exhausted');
    expect(h.reason).toMatch(/^needs a paid plan or a payment method at the provider; after adding one, run "omnitrix test mistral": HTTP 402: You need a subscription/);
    expect(Math.abs(h.until! - h.at! - 24 * 3600_000)).toBeLessThan(50);
  });

  it('rests a local model for an hour when its server process crashed, and uses another model meanwhile', async () => {
    const p = await mockProvider((call) => (call.body.model === 'qwen-35b'
      ? { status: 500, json: { error: { message: 'llama-server process has terminated: exit status 0xc0000409' } } }
      : { json: chatReply('ok') }));
    closers.push(p.close);
    writeConfig([account({ id: 'ollama', baseUrl: p.url, local: true, models: [makeModel('qwen-35b'), makeModel('gemma-12b')] })]);
    const engine = new Engine();
    // the crashing model first, as the bigger one would be for a hard task
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p', privacy: 'public', use: 'ollama/qwen-35b' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(`${done!.status}@${done!.model}`).toBe('done@gemma-12b');
    const h = loadHealth()[modelHealthKey('ollama', 'qwen-35b')]!;
    expect(h.reason).toBe('its server process crashed');
    expect(Math.abs(h.until! - h.at! - 3600_000)).toBeLessThan(50);
  });

  it('rests a single paid model as long as the provider says, not for a day', async () => {
    const p = await mockProvider(() => ({ status: 402, headers: { 'retry-after': '120' }, json: { error: { message: 'This request requires more credits, or fewer max_tokens.' } } }));
    closers.push(p.close);
    setSecret('openrouter', 'sk-test-openrouter-000000');
    writeConfig([account({ id: 'openrouter', baseUrl: p.url, apiKey: 'secret' })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p', privacy: 'public' }]);
    await engine.wait([job!.id], 10);
    const h = loadHealth().openrouter!;
    expect(Math.abs(h.until! - h.at! - 120_000)).toBeLessThan(50);
  });

  it('does not lengthen the rest for refusals that arrive together, before any rest ended', async () => {
    const p = await mockProvider(() => ({ status: 429, headers: { 'retry-after': '1' }, json: { error: { message: 'Requests per minute limit exceeded - too many requests sent.' } }, delayMs: 100 }));
    closers.push(p.close);
    setSecret('cerebras', 'sk-test-cerebras-00000000');
    writeConfig([account({ id: 'cerebras', baseUrl: p.url, apiKey: 'secret', concurrency: 3 })]);
    const engine = new Engine();
    const jobs = engine.dispatch([1, 2, 3].map((i) => ({ title: `t${i}`, type: 'writing' as const, prompt: 'p', privacy: 'public' as const })));
    for (let i = 0; i < 80 && p.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 400));
    const h = loadHealth().cerebras!;
    expect(Math.abs(h.until! - h.at! - 2000)).toBeLessThan(50);
    for (const j of jobs) engine.cancel(j.id);
  });

  it('rests a local model only briefly after an ordinary server error', async () => {
    const p = await mockProvider((call) => (call.body.model === 'qwen-35b' ? { status: 500, json: { error: { message: 'internal error' } } } : { json: chatReply('ok') }));
    closers.push(p.close);
    writeConfig([account({ id: 'ollama', baseUrl: p.url, local: true, models: [makeModel('qwen-35b'), makeModel('gemma-12b')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p', privacy: 'public', use: 'ollama/qwen-35b' }]);
    await engine.wait([job!.id], 10);
    const h = loadHealth()[modelHealthKey('ollama', 'qwen-35b')]!;
    expect(Math.abs(h.until! - h.at! - 5 * 60_000)).toBeLessThan(50);
  });
});
