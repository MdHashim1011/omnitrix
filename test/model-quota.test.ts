import { afterEach, describe, expect, it } from 'vitest';
import { classifyStatus } from '../src/drivers/http.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { files, readJson } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// Found on a second computer: an allowance that belongs to one model (Groq's tokens per day, Gemini's per-model
// quota) marked the whole account out of quota, and a billing link in an answer made a short wait look like an
// empty account. These rules must hold for any provider, not only the ones connected today.
const strong = (id: string) => makeModel(id, { skills: { coding: 9, reasoning: 9, writing: 9, longContext: 9, vision: 0, speed: 8 } });
const weak = (id: string) => makeModel(id, { skills: { coding: 3, reasoning: 3, writing: 3, longContext: 3, vision: 0, speed: 3 } });
const groqDay = (model: string) => ({ error: { message: `Rate limit reached for model \`${model}\` in organization \`org_1\` service tier \`on_demand\` on tokens per day (TPD): Limit 500000, Used 499800, Requested 900. Please try again in 2m35s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing`, type: 'tokens', code: 'rate_limit_exceeded' } });
const geminiDay = JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-2.5-pro', location: 'global' } }] }] } }]);

describe('an allowance that belongs to one model', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it('reads a daily limit that names its model as that model\'s, and an account-wide one as the account\'s', () => {
    expect(classifyStatus(429, JSON.stringify(groqDay('llama')))).toBe('model_quota');
    expect(classifyStatus(429, geminiDay)).toBe('model_quota');
    // the quota id alone names the model's own allowance
    expect(classifyStatus(429, 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 50, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier')).toBe('model_quota');
    expect(classifyStatus(429, 'Rate limit reached for gpt-x in organization org-1 on requests per day (RPD): Limit 200, Used 200, Requested 1.')).toBe('model_quota');
    // no model named: the account is out, as before
    expect(classifyStatus(429, 'You exceeded your current quota, please check your plan and billing details.')).toBe('quota');
    expect(classifyStatus(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"}}')).toBe('quota');
  });

  it('reads what other providers say about their limits', () => {
    // Gemini: a minute limit named inside a quota id is a short wait
    expect(classifyStatus(429, '{"error":{"code":429,"message":"You exceeded your current quota","details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","quotaDimensions":{"model":"gemini-3-flash"}}]},{"retryDelay":"29s"}]}}')).toBe('rate_limit');
    // Gemini: a minute limit beside a day limit is the day limit, of that model
    expect(classifyStatus(429, '{"error":{"message":"You exceeded your current quota","details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"},{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}')).toBe('model_quota');
    // Gemini without details: most often one model's, so the others keep their turn
    expect(classifyStatus(429, '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}')).toBe('model_quota');
    // Google through another service, with underscores
    expect(classifyStatus(429, 'Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model with base model: gemini-experimental.')).toBe('rate_limit');
    // Anthropic's spend cap holds the whole organization
    expect(classifyStatus(429, '{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits. You will regain access on 2026-12-01.","details":{"error_code":"enforced_spend_limit_reached"}}}')).toBe('quota');
    // OpenRouter: the free daily allowance is the key's, in any wording; an upstream throttle is one busy model
    expect(classifyStatus(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day. "}}')).toBe('quota');
    expect(classifyStatus(429, '{"error":{"message":"Provider returned error","metadata":{"raw":"google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream.","limit_source":"upstream_provider_shared_pool"}}}')).toBe('server');
    // OpenRouter: its limit on spending in flight passes in a moment
    expect(classifyStatus(402, '{"error":{"message":"in-flight budget","metadata":{"reason":"in_flight_budget_exhausted"}}}')).toBe('rate_limit');
    // Alibaba's DashScope words a limit per minute like an empty plan, with a link that says otherwise
    expect(classifyStatus(429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details. For details, see: https://help.aliyun.com/zh/model-studio/error-code#token-limit","type":"insufficient_quota"}}')).toBe('rate_limit');
    // a link inside compact JSON does not swallow the words after it
    expect(classifyStatus(429, '{"error":{"message":"see https://example.com/billing","note":"your credit balance is too low"}}')).toBe('quota');
    expect(classifyStatus(429, '{"error":{"message":"Rate limit, see https://ai.google.dev/rate","quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}')).toBe('model_quota');
  });

  it('does not read a billing link as the account being out of credit', () => {
    expect(classifyStatus(429, 'Too many requests, slow down. See https://example.com/settings/billing for higher limits')).toBe('rate_limit');
    expect(classifyStatus(429, 'Too many requests. Your credit balance is too low.')).toBe('quota');
  });

  it('rests only that model, for as long as the provider says, and the account keeps answering', async () => {
    tempHome();
    const groq = await mockProvider((call) => (call.body?.model === 'big' ? { status: 429, headers: { 'retry-after': '155' }, json: groqDay('big') } : { json: chatReply('from small') }));
    closers.push(groq.close);
    writeConfig([account({ id: 'groq', baseUrl: groq.url, local: true, models: [strong('big'), weak('small')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    expect((await engine.wait([job!.id], 15))[0]).toMatchObject({ status: 'done', accountId: 'groq', model: 'small' });
    const view = engine.pool().find((a) => a.id === 'groq')!;
    expect(view.state).toBe('ready');
    expect(view.pausedModels).toEqual(['big']);
    // for the 155 seconds Groq named, not the hour used when a provider names no time
    const rest = readJson<Record<string, { until: number }>>(files.health(), {})['groq/big']!;
    expect(rest.until - Date.now()).toBeLessThan(200_000);
    const [next] = engine.dispatch([{ title: 't2', type: 'writing', prompt: 'q2' }]);
    await engine.wait([next!.id], 15);
    expect(groq.calls.filter((c) => c.body?.model === 'big')).toHaveLength(1);
  }, 20_000);

  it('does not take the short wait of a minute limit for a day limit named beside it', async () => {
    tempHome();
    const both = { error: { code: 429, message: 'You exceeded your current quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }, { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '30s' }] } };
    const gem = await mockProvider((call) => (call.body?.model === 'pro' ? { status: 429, json: both } : { json: chatReply('from flash') }));
    closers.push(gem.close);
    writeConfig([account({ id: 'gem', baseUrl: gem.url, local: true, models: [strong('pro'), weak('flash')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    expect((await engine.wait([job!.id], 15))[0]).toMatchObject({ status: 'done', model: 'flash' });
    const rest = readJson<Record<string, { until: number }>>(files.health(), {})['gem/pro']!;
    expect(rest.until - Date.now()).toBeGreaterThan(30 * 60_000);
  }, 20_000);

  it('rests the account when its only model is out', async () => {
    tempHome();
    const one = await mockProvider(() => ({ status: 429, json: groqDay('only') }));
    closers.push(one.close);
    writeConfig([account({ id: 'one', baseUrl: one.url, local: true, models: [strong('only')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    await engine.wait([job!.id], 15);
    expect(engine.pool().find((a) => a.id === 'one')!.state).toBe('exhausted');
  }, 20_000);

  it('gives every model of the account its turn, each only once, and skips the spent ones afterwards', async () => {
    tempHome();
    const lab = await mockProvider((call) => ({ status: 429, json: groqDay(String(call.body?.model)) }));
    const backup = await mockProvider(() => ({ json: chatReply('from backup') }));
    closers.push(lab.close, backup.close);
    writeConfig([
      account({ id: 'lab', baseUrl: lab.url, local: true, models: Array.from({ length: 8 }, (_, i) => strong(`lab-${i}`)) }),
      account({ id: 'backup', baseUrl: backup.url, local: true, models: [weak('backup-model')] }),
    ]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    expect((await engine.wait([job!.id], 15))[0]).toMatchObject({ status: 'done', accountId: 'backup' });
    // a model that still had allowance would have answered; none is asked twice
    expect(lab.calls.filter((c) => c.body?.messages)).toHaveLength(8);
    expect(new Set(lab.calls.map((c) => c.body?.model)).size).toBe(8);
    const [next] = engine.dispatch([{ title: 't2', type: 'writing', prompt: 'q2' }]);
    expect((await engine.wait([next!.id], 15))[0]).toMatchObject({ status: 'done', accountId: 'backup' });
    expect(lab.calls.filter((c) => c.body?.messages)).toHaveLength(8);
  }, 20_000);
});
