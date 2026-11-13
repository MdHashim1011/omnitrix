import { beforeEach, describe, expect, it } from 'vitest';
import { classifyStatus, parseDuration, readRateHeaders, retryAfterMs } from '../src/drivers/http.js';
import { guessSkills, isChatModel } from '../src/models.js';
import { redact } from '../src/store.js';
import { headroom, readLedger, recordUsage, summarize } from '../src/usage.js';
import { account, tempHome } from './helpers.js';

describe('usage ledger', () => {
  beforeEach(() => tempHome());

  it('counts requests and tokens per window and computes what is left', () => {
    const now = Date.now();
    const acc = account({ id: 'a', limits: { requestsPerDay: 10, tokensPerDay: 1000 } });
    for (let i = 0; i < 4; i++) recordUsage({ ts: now - i * 1000, accountId: 'a', model: 'm', inputTokens: 100, outputTokens: 50, ok: true, latencyMs: 5 });
    // an old record and another account's record must not count
    recordUsage({ ts: now - 2 * 86400_000, accountId: 'a', model: 'm', inputTokens: 999, outputTokens: 0, ok: true, latencyMs: 5 });
    recordUsage({ ts: now, accountId: 'b', model: 'm', inputTokens: 999, outputTokens: 0, ok: true, latencyMs: 5 });
    // a network failure never reached the model, so it is not counted
    recordUsage({ ts: now, accountId: 'a', model: 'm', inputTokens: 0, outputTokens: 0, ok: false, errorKind: 'network', latencyMs: 5 });

    const s = summarize(acc, readLedger(), undefined, now);
    expect(s.requestsToday).toBe(4);
    expect(s.tokensToday).toBe(600);
    const req = s.windows.find((w) => w.unit === 'requests')!;
    expect(req.remaining).toBe(6);
    const tok = s.windows.find((w) => w.unit === 'tokens')!;
    expect(tok.remaining).toBe(400);
    expect(s.percentUsed).toBe(60);
    expect(s.source).toBe('estimated');
    expect(headroom(s)).toBeCloseTo(0.4);
  });

  it('prefers fresh numbers from the provider', () => {
    const now = Date.now();
    const acc = account({ id: 'a' });
    const s = summarize(acc, [], { state: 'ready', measured: { remainingRequests: 0, at: now - 1000, source: 'headers' } }, now);
    expect(s.source).toBe('measured');
    expect(headroom(s)).toBe(0);
    const stale = summarize(acc, [], { state: 'ready', measured: { remainingRequests: 0, at: now - 3600_000, source: 'headers' } }, now);
    expect(stale.source).toBe('untracked');
  });

  it('skips broken lines in the ledger', async () => {
    const fs = await import('node:fs');
    const { files } = await import('../src/store.js');
    recordUsage({ ts: 1, accountId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1 });
    fs.appendFileSync(files.ledger(), '{"ts": 2, "acc\n');
    expect(readLedger()).toHaveLength(1);
  });
});

describe('http helpers', () => {
  it('classifies provider errors', () => {
    expect(classifyStatus(401, '')).toBe('auth');
    expect(classifyStatus(402, '')).toBe('quota');
    expect(classifyStatus(429, 'Rate limit reached for requests')).toBe('rate_limit');
    expect(classifyStatus(429, 'You exceeded your current quota')).toBe('quota');
    expect(classifyStatus(503, '')).toBe('server');
    expect(classifyStatus(400, '')).toBe('bad_request');
    // a retired or unknown model: the job should move on to another model, not fail
    expect(classifyStatus(404, '{"error":{"message":"This model models/gemini-2.5-flash is no longer available to new users."}}')).toBe('model_gone');
    expect(classifyStatus(404, '{"error":{"message":"The model `gpt-x` does not exist"}}')).toBe('model_gone');
    expect(classifyStatus(404, 'page not found')).toBe('bad_request');
    // a plan with no allowance for one model must not mark the whole account as out of quota
    expect(classifyStatus(429, 'Quota exceeded for metric: free_tier_input_token_count, limit: 0, model: gemini-3.1-pro')).toBe('model_gone');
    expect(classifyStatus(429, 'Quota exceeded for metric: free_tier_requests, limit: 250, model: gemini-flash')).toBe('quota');
  });

  it('parses durations and retry headers', () => {
    expect(parseDuration('1m30s')).toBe(90_000);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('12.5s')).toBe(12_500);
    expect(parseDuration('2')).toBe(2000);
    const now = 1_700_000_000_000;
    expect(parseDuration(String(now / 1000 + 30), now)).toBe(30_000);
    expect(retryAfterMs(new Headers({ 'retry-after': '7' }))).toBe(7000);
    const rate = readRateHeaders(new Headers({ 'x-ratelimit-remaining-requests': '42', 'x-ratelimit-reset-requests': '10s' }), now);
    expect(rate).toEqual({ remainingRequests: 42, remainingTokens: undefined, resetAt: now + 10_000 });
    expect(readRateHeaders(new Headers({}))).toBeUndefined();
  });

  it('hides secrets in messages', () => {
    const out = redact('bad key sk-abcdefghijklmnop1234 and Bearer abcdefghijklmnopqrstu and "api_key": "zzzzzzzzzzzz"');
    expect(out).not.toMatch(/abcdefghijklmnop1234|abcdefghijklmnopqrstu|zzzzzzzzzzzz/);
  });
});

describe('model guesses', () => {
  it('gives coders a high coding score and small models high speed', () => {
    expect(guessSkills('qwen3-coder-480b').coding).toBe(9);
    expect(guessSkills('llama3.2:3b').speed).toBe(9);
    expect(guessSkills('qwen2.5vl:7b').vision).toBeGreaterThanOrEqual(5);
    expect(guessSkills('llama3.2:3b').vision).toBe(0);
  });

  it('filters out non-chat models', () => {
    expect(isChatModel('text-embedding-3-large')).toBe(false);
    expect(isChatModel('whisper-large-v3')).toBe(false);
    expect(isChatModel('deepseek-v4-pro')).toBe(true);
  });

  it('filters out Gemini music, image, live and agent models', () => {
    for (const id of ['models/lyria-3.5', 'models/lyria-realtime-exp', 'models/gemini-3.1-flash-image', 'models/gemini-2.5-flash-image', 'models/gemini-nano-banana-2.1',
      'models/gemini-3.8-live', 'models/gemini-3.8-live-extended-thinking', 'models/gemini-3.5-live-translate-preview', 'models/deep-research-pro-preview-12-2025',
      'models/gemini-2.5-computer-use-preview-10-2025', 'models/aqa']) expect(isChatModel(id), id).toBe(false);
    // chat models with similar names stay, including ones that read images
    for (const id of ['models/gemini-3-flash-preview', 'models/gemini-3.1-flash-lite', 'models/gemini-omni-1.2-flash', 'models/gemma-4-31b-it', 'qwen2.5vl:3b', 'gpt-5.2-image-reader'])
      expect(isChatModel(id), id).toBe(true);
  });
});
