import { afterEach, describe, expect, it } from 'vitest';
import { classifyStatus, minuteLimit } from '../src/drivers/http.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { files, readJson, writeJson } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// Found on a second computer: a free Groq key allows each model only a few thousand tokens a minute. omnitrix
// asked for up to 16,000 answer tokens, so Groq refused every request as too large, and because its answer
// offers an upgrade "at .../settings/billing", omnitrix took the account for out of quota.
const strong = (id: string) => makeModel(id, { skills: { coding: 9, reasoning: 9, writing: 9, longContext: 9, vision: 0, speed: 8 } });
const weak = (id: string) => makeModel(id, { skills: { coding: 3, reasoning: 3, writing: 3, longContext: 3, vision: 0, speed: 3 } });
const upsell = ' Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';
const tooLarge = (kind: string, limit: number, requested: number) =>
  JSON.stringify({ error: { message: `Request too large for model \`qwen/qwen3.6-27b\` in organization \`org_1\` service tier \`on_demand\` on ${kind}: Limit ${limit}, Requested ${requested}, please reduce your message size and try again.${upsell}`, type: 'tokens', code: 'rate_limit_exceeded' } });

describe('a model with a small per-minute token limit', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it('reads "request too large" as too big for the model and a per-minute limit as a short wait, even with an upgrade offer', () => {
    expect(classifyStatus(429, tooLarge('tokens per minute (TPM)', 6000, 16400))).toBe('too_long');
    expect(classifyStatus(413, tooLarge('tokens per minute (TPM)', 6000, 16400))).toBe('too_long');
    const busy = JSON.stringify({ error: { message: `Rate limit reached for model \`m\` in organization \`o\` on tokens per minute (TPM): Limit 6000, Used 5000, Requested 2000. Please try again in 10s.${upsell}` } });
    expect(classifyStatus(429, busy)).toBe('rate_limit');
    // a daily allowance that names its model is that model's (see model-quota.test.ts)
    const day = JSON.stringify({ error: { message: `Rate limit reached for model \`m\` on tokens per day (TPD): Limit 100000, Used 99900, Requested 900.${upsell}` } });
    expect(classifyStatus(429, day)).toBe('model_quota');
    expect(classifyStatus(429, 'You exceeded your current quota, please check your plan and billing details.')).toBe('quota');
    // a day limit named next to a minute limit is still the day limit
    expect(classifyStatus(429, 'Quota exceeded for requests per day and per minute; check your billing')).toBe('quota');
    // OpenAI writes "per min" and links its billing page in the same answer
    expect(classifyStatus(429, 'Rate limit reached for gpt-x in organization org-1 on requests per min (RPM): Limit 3, Used 3, Requested 1. Visit https://platform.openai.com/account/billing')).toBe('rate_limit');
    // a model the plan does not include at all stays a missing model
    expect(classifyStatus(429, 'Request too large for model m on tokens per minute (TPM): Limit: 0, Requested 16000')).toBe('model_gone');
    // a request too large for the server in any unit is never worth repeating as it is
    expect(classifyStatus(413, '{"error":{"message":"Payload Too Large"}}')).toBe('too_long');
  });

  it('reads the limit and whether it counts only the answer', () => {
    expect(minuteLimit(tooLarge('tokens per minute (TPM)', 6000, 16400))).toEqual({ tokens: 6000, outputOnly: false });
    expect(minuteLimit(tooLarge('output tokens per minute (OTPM)', 8000, 16384))).toEqual({ tokens: 8000, outputOnly: true });
    expect(minuteLimit('Rate limit reached for requests')).toBeUndefined();
    expect(minuteLimit('Request too large for gpt-x in organization org-1 on tokens per min (TPM): Limit 30000, Requested 33022.')).toEqual({ tokens: 30000, outputOnly: false });
    // a size in bytes, or a limit of 0, is no token limit for a minute
    expect(minuteLimit('Request too large. Limit: 8192 bytes')).toBeUndefined();
    expect(minuteLimit(tooLarge('tokens per minute (TPM)', 0, 16000))).toBeUndefined();
  });

  it('keeps the account ready, and asks that model again for an answer that fits its limit', async () => {
    tempHome();
    const groq = await mockProvider((call) => {
      const wanted = Number(call.body?.max_tokens ?? 0);
      if (call.body?.model === 'qwen' && wanted > 6000) return { status: 429, json: JSON.parse(tooLarge('tokens per minute (TPM)', 6000, wanted + 100)) };
      // the reply counts the prompt it read, so the long second prompt is not taken for a cut one
      return { json: chatReply(`answer from ${call.body?.model}`, { prompt_tokens: 3000, completion_tokens: 5 }) };
    });
    closers.push(groq.close);
    writeConfig([account({ id: 'groq', baseUrl: groq.url, local: true, models: [strong('qwen'), weak('llama')] })]);
    // a prompt size learned earlier for this model keeps its own expiry
    const hour = Date.now() + 3600_000;
    writeJson(files.health(), { 'groq/qwen#context': { state: 'ready', contextTokens: 50_000, until: hour } });
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'short question' }]);
    const [done] = await engine.wait([job!.id], 15);
    // the same model answers at once with a shorter answer; nothing about the account is used up
    expect(done).toMatchObject({ status: 'done', accountId: 'groq', model: 'qwen' });
    expect(engine.pool().find((a) => a.id === 'groq')).toMatchObject({ state: 'ready', pausedModels: [] });
    // a longer prompt leaves less of the limit for the answer
    const [next] = engine.dispatch([{ title: 't2', type: 'writing', prompt: 'word '.repeat(1500) }]);
    const [second] = await engine.wait([next!.id], 15);
    expect(second).toMatchObject({ status: 'done', model: 'qwen' });
    const asked = groq.calls.filter((c) => c.body?.model === 'qwen').map((c) => Number(c.body?.max_tokens));
    expect(asked).toHaveLength(3);
    expect(asked[0]).toBe(16000);
    expect(asked[1]).toBeGreaterThan(4000);
    expect(asked[1]).toBeLessThanOrEqual(6000 * 0.9);
    // about 2,500 prompt tokens counted high leave under 3,500 of the 6,000
    expect(asked[2]).toBeLessThan(3500);
    expect(asked[2]).toBeGreaterThan(1000);
    const health = readJson<Record<string, object>>(files.health(), {});
    expect(health['groq/qwen#context']).toEqual({ state: 'ready', contextTokens: 50_000, until: hour });
    expect(health['groq/qwen#minute']).toMatchObject({ minuteTokens: 6000, minuteOutputOnly: false });
  }, 20_000);

  it('caps only the answer when the limit counts only output tokens', async () => {
    tempHome();
    const groq = await mockProvider((call) => {
      const wanted = Number(call.body?.max_tokens ?? 0);
      if (wanted > 8000) return { status: 429, json: JSON.parse(tooLarge('output tokens per minute (OTPM)', 8000, wanted)) };
      return { json: chatReply('fits') };
    });
    closers.push(groq.close);
    writeConfig([account({ id: 'groq', baseUrl: groq.url, local: true, models: [strong('qwen')] })]);
    const engine = new Engine();
    const question = 'a short question';
    // an account with this one model still gets the first job done
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: question }]);
    expect((await engine.wait([job!.id], 15))[0]).toMatchObject({ status: 'done', model: 'qwen' });
    expect(engine.pool().find((a) => a.id === 'groq')!.state).toBe('ready');
    const [next] = engine.dispatch([{ title: 't2', type: 'writing', prompt: question }]);
    expect((await engine.wait([next!.id], 15))[0]).toMatchObject({ status: 'done', model: 'qwen' });
    expect(groq.calls.filter((c) => c.body?.messages).map((c) => Number(c.body?.max_tokens))).toEqual([16000, 7200, 7200]);
  }, 20_000);

  it('tries the same model only once more, and then another model', async () => {
    tempHome();
    // each refusal names a smaller limit, so only the count of tries stops the model being asked again
    const groq = await mockProvider((call) => {
      const wanted = Number(call.body?.max_tokens ?? 0);
      return call.body?.model === 'qwen' ? { status: 429, json: JSON.parse(tooLarge('output tokens per minute (OTPM)', Math.floor(wanted / 2), wanted)) } : { json: chatReply('from llama') };
    });
    closers.push(groq.close);
    writeConfig([account({ id: 'groq', baseUrl: groq.url, local: true, models: [strong('qwen'), weak('llama')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    expect((await engine.wait([job!.id], 15))[0]).toMatchObject({ status: 'done', model: 'llama' });
    expect(groq.calls.filter((c) => c.body?.model === 'qwen')).toHaveLength(2);
  }, 20_000);

  it('does not ask the same model again when the limit it names would not shorten the request', async () => {
    tempHome();
    const groq = await mockProvider((call) => (call.body?.model === 'qwen' ? { status: 429, json: JSON.parse(tooLarge('output tokens per minute (OTPM)', 20000, 16000)) } : { json: chatReply('from llama') }));
    closers.push(groq.close);
    writeConfig([account({ id: 'groq', baseUrl: groq.url, local: true, models: [strong('qwen'), weak('llama')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    expect((await engine.wait([job!.id], 15))[0]).toMatchObject({ status: 'done', model: 'llama' });
    expect(groq.calls.filter((c) => c.body?.model === 'qwen')).toHaveLength(1);
  }, 20_000);

  it('never asks a model for more than its limit allows, even for a short answer', async () => {
    tempHome();
    const groq = await mockProvider((call) => (call.body?.model === 'tiny' ? { status: 429, json: JSON.parse(tooLarge('output tokens per minute (OTPM)', 800, 4000)) } : { json: chatReply('ok') }));
    closers.push(groq.close);
    writeConfig([account({ id: 'groq', baseUrl: groq.url, local: true, models: [strong('tiny'), weak('llama')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q', size: 'small' }]);
    expect((await engine.wait([job!.id], 15))[0]).toMatchObject({ status: 'done', model: 'llama' });
    // 800 tokens leave room for no useful answer, so the model is not asked again with a request it refuses
    expect(groq.calls.filter((c) => c.body?.model === 'tiny')).toHaveLength(1);
    expect(JSON.stringify(engine.preview({ title: 'n', type: 'writing', prompt: 'q', size: 'small' }))).toMatch(/per-minute limit of 800 tokens/);
  }, 20_000);

  it('does not send a model a task whose prompt alone fills its minute', async () => {
    tempHome();
    const groq = await mockProvider((call) => {
      const wanted = Number(call.body?.max_tokens ?? 0);
      if (call.body?.model === 'qwen' && wanted > 3000) return { status: 429, json: JSON.parse(tooLarge('tokens per minute (TPM)', 3000, wanted)) };
      return { json: chatReply('ok') };
    });
    closers.push(groq.close);
    writeConfig([account({ id: 'groq', baseUrl: groq.url, local: true, models: [strong('qwen'), weak('llama')] })]);
    const engine = new Engine();
    const [first] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    await engine.wait([first!.id], 15);
    const plan = engine.preview({ title: 'big', type: 'writing', prompt: 'word '.repeat(12000) });
    expect(JSON.stringify(plan)).toMatch(/per-minute limit of 3,000 tokens/);
  }, 20_000);
});
