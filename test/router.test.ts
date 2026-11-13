import { describe, expect, it } from 'vitest';
import { makeModel } from '../src/models.js';
import { fit, route, type RouteContext } from '../src/router.js';
import { defaultSettings } from '../src/store.js';
import type { Account, Config, TaskSpec } from '../src/types.js';
import { account } from './helpers.js';

function ctx(accounts: Account[], over: Partial<RouteContext> = {}, settings: Partial<Config['settings']> = {}): RouteContext {
  return {
    config: { version: 1, accounts, settings: { ...defaultSettings, ...settings } },
    health: {},
    usage: {},
    running: {},
    stats: {},
    ...over,
  };
}

const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({ title: 't', type: 'writing', prompt: 'p', ...over });

describe('router', () => {
  it('prefers the model whose skills fit the task', () => {
    const coder = account({ id: 'a', models: [makeModel('qwen3-coder-plus')] });
    const tiny = account({ id: 'b', models: [makeModel('llama3.2:3b')] });
    const { candidates } = route(task({ type: 'code_snippet' }), ctx([tiny, coder]));
    expect(candidates[0]!.accountId).toBe('a');
  });

  it('only sends code tasks to agent CLIs', () => {
    const api = account({ id: 'api' });
    const cli = account({ id: 'cli', driver: 'cli', provider: 'codex', models: [makeModel('default')] });
    const { candidates, rejected } = route(task({ type: 'code', repo: '/x' }), ctx([api, cli]));
    expect(candidates.map((c) => c.accountId)).toEqual(['cli']);
    expect(rejected.find((r) => r.accountId === 'api')?.reason).toMatch(/agent CLI/);
  });

  it('keeps private work away from providers that train on data', () => {
    const free = account({ id: 'free', trainsOnData: true });
    const paid = account({ id: 'paid' });
    expect(route(task({ privacy: 'private' }), ctx([free, paid])).candidates.map((c) => c.accountId)).toEqual(['paid']);
    expect(route(task({ privacy: 'public' }), ctx([free, paid])).candidates).toHaveLength(2);
    // the user can turn the protection off
    expect(route(task({ privacy: 'private' }), ctx([free, paid], {}, { protectPrivate: false })).candidates).toHaveLength(2);
  });

  it('sends secret work only to local models', () => {
    const local = account({ id: 'local', local: true });
    const cloud = account({ id: 'cloud' });
    expect(route(task({ privacy: 'secret' }), ctx([local, cloud])).candidates.map((c) => c.accountId)).toEqual(['local']);
  });

  it('skips cooling, exhausted and logged-out accounts, but not expired cooldowns', () => {
    const now = 1_000_000;
    const a = account({ id: 'a' });
    const b = account({ id: 'b' });
    const c = account({ id: 'c' });
    const d = account({ id: 'd' });
    const health = {
      a: { state: 'cooling' as const, until: now + 5000 },
      b: { state: 'auth_error' as const },
      c: { state: 'exhausted' as const, until: now - 1 },
    };
    const ids = route(task(), ctx([a, b, c, d], { health, now })).candidates.map((x) => x.accountId).sort();
    expect(ids).toEqual(['c', 'd']);
  });

  it('skips accounts with no quota left and favours the one with more left', () => {
    const a = account({ id: 'a' });
    const b = account({ id: 'b' });
    const c = account({ id: 'c' });
    const mk = (id: string, percentUsed: number) => ({ accountId: id, requestsToday: 0, tokensToday: 0, tokensMonth: 0, costToday: 0, windows: [], percentUsed, source: 'estimated' as const });
    const usage = { a: mk('a', 100), b: mk('b', 90), c: mk('c', 10) };
    const { candidates, rejected } = route(task(), ctx([a, b, c], { usage }));
    expect(candidates.map((x) => x.accountId)).toEqual(['c', 'b']);
    expect(rejected[0]!.reason).toMatch(/no quota/);
  });

  it('honours pins, bans and forced accounts', () => {
    const a = account({ id: 'a', models: [makeModel('big-pro-max')] });
    const b = account({ id: 'b', provider: 'groq', models: [makeModel('small-mini')] });
    expect(route(task(), ctx([a, b], {}, { pins: { writing: ['b'] } })).candidates[0]!.accountId).toBe('b');
    expect(route(task(), ctx([a, b], {}, { bannedProviders: ['groq'] })).candidates.map((c) => c.accountId)).toEqual(['a']);
    expect(route(task({ use: 'b/small-mini' }), ctx([a, b])).candidates.map((c) => `${c.accountId}/${c.model}`)).toEqual(['b/small-mini']);
  });

  it('learns from accepted and rejected results', () => {
    const a = account({ id: 'a', models: [makeModel('model-a')] });
    const b = account({ id: 'b', models: [makeModel('model-b')] });
    const now = Date.now();
    const stats = { 'model-a|writing': { ok: 0, bad: 8, at: now }, 'model-b|writing': { ok: 8, bad: 0, at: now } };
    expect(route(task(), ctx([a, b], { stats, now })).candidates[0]!.accountId).toBe('b');
  });

  it('routes images only to models that can read them', () => {
    const a = account({ id: 'a', models: [makeModel('llama3.2:3b'), makeModel('qwen2.5vl:7b')] });
    const { candidates } = route(task({ type: 'vision' }), ctx([a]));
    expect(candidates.map((c) => c.model)).toEqual(['qwen2.5vl:7b']);
  });

  it('fit stays between 0 and 1', () => {
    for (const type of ['code', 'bulk', 'vision', 'reasoning'] as const) {
      const f = fit({ coding: 10, reasoning: 10, writing: 10, longContext: 10, vision: 10, speed: 10 }, type);
      expect(f).toBeCloseTo(1, 5);
    }
  });
});

describe('router quota timing and free tiers', () => {
  const now = 10_000_000_000;
  const MIN = 60_000;
  type W = { remaining: number; resetsAt?: number; runsOutAt?: number };
  const usage = (id: string, ...ws: W[]) => ({
    accountId: id, requestsToday: 0, tokensToday: 0, tokensMonth: 0, costToday: 0, source: 'measured' as const,
    percentUsed: Math.max(...ws.map((w) => 100 - w.remaining)),
    windows: ws.map((w) => ({ name: '5 hours', unit: 'percent' as const, used: 100 - w.remaining, limit: 100, ...w })),
  });
  const pair = () => [account({ id: 'a', priority: 1 }), account({ id: 'b', priority: 0 })];

  it('prefers quota that resets within the hour and would otherwise go unused', () => {
    const u = { a: usage('a', { remaining: 60, resetsAt: now + 30 * MIN }), b: usage('b', { remaining: 60, resetsAt: now + 4 * 60 * MIN }) };
    const { candidates } = route(task(), ctx(pair(), { usage: u, now }));
    expect(candidates[0]!.accountId).toBe('a');
    expect(candidates[0]!.why.join(' ')).toMatch(/resets in 30 min with 60% left/);
  });

  it('gives no reset boost when little is left or the reset is far off', () => {
    const little = { a: usage('a', { remaining: 15, resetsAt: now + 30 * MIN }), b: usage('b', { remaining: 15, resetsAt: now + 4 * 60 * MIN }) };
    const far = { a: usage('a', { remaining: 60, resetsAt: now + 61 * MIN }), b: usage('b', { remaining: 60, resetsAt: now + 4 * 60 * MIN }) };
    for (const u of [little, far]) {
      const { candidates } = route(task(), ctx(pair(), { usage: u, now }));
      expect(candidates[0]!.accountId).toBe('b');
      expect(candidates.flatMap((c) => c.why).join(' ')).not.toMatch(/resets in/);
    }
  });

  it('spares an account that is forecast to run out before it resets', () => {
    const u = { a: usage('a', { remaining: 60 }), b: usage('b', { remaining: 60, resetsAt: now + 3 * 60 * MIN, runsOutAt: now + 50 * MIN }) };
    const [first, second] = route(task(), ctx(pair(), { usage: u, now })).candidates;
    expect(first!.accountId).toBe('a');
    expect(second!.why.join(' ')).toMatch(/runs out in about 50 min at this pace/);
  });

  it('gives public work to free tiers so paid quota lasts longer', () => {
    const free = account({ id: 'free', trainsOnData: true, priority: 1 });
    const plan = account({ id: 'plan', priority: 0 });
    const pub = route(task({ privacy: 'public' }), ctx([free, plan]));
    expect(pub.candidates[0]!.accountId).toBe('free');
    expect(pub.candidates[0]!.why.join(' ')).toMatch(/takes public work only/);
    // quality mode leaves this out and ranks on skill and quota
    expect(route(task({ privacy: 'public' }), ctx([free, plan], {}, { mode: 'quality' })).candidates[0]!.accountId).toBe('plan');
    // with the privacy protection off, private work may reach a free tier, but is not steered there
    const priv = route(task({ privacy: 'private' }), ctx([free, plan], {}, { protectPrivate: false }));
    expect(priv.candidates[0]!.accountId).toBe('plan');
    expect(priv.candidates.flatMap((c) => c.why).join(' ')).not.toMatch(/public work only/);
  });

  it('does not treat a paid model as a free tier', () => {
    const priced = account({ id: 'priced', trainsOnData: true, priority: 1, models: [makeModel('test-model', { inputPrice: 0.1, outputPrice: 0.1 })] });
    const plan = account({ id: 'plan', priority: 0 });
    const { candidates } = route(task({ privacy: 'public' }), ctx([priced, plan]));
    expect(candidates.flatMap((c) => c.why).join(' ')).not.toMatch(/public work only/);
  });

  it('beats an account with somewhat more quota left when its own quota is about to reset', () => {
    const u = { a: usage('a', { remaining: 60, resetsAt: now + 30 * MIN }), b: usage('b', { remaining: 80, resetsAt: now + 4 * 60 * MIN }) };
    expect(route(task(), ctx(pair(), { usage: u, now })).candidates[0]!.accountId).toBe('a');
  });

  it('gives no reset bonus when another window on the account is nearly spent', () => {
    const tight = usage('a', { remaining: 60, resetsAt: now + 30 * MIN }, { remaining: 10, resetsAt: now + 3 * 24 * 60 * MIN });
    const { candidates } = route(task(), ctx([account({ id: 'a' })], { usage: { a: tight }, now }));
    expect(candidates[0]!.why.join(' ')).not.toMatch(/resets in/);
  });

  it('lets a forecast to run dry win over a reset bonus, quoting the earliest run-out', () => {
    const both = usage('a', { remaining: 60, resetsAt: now + 30 * MIN }, { remaining: 70, resetsAt: now + 5 * 60 * MIN, runsOutAt: now + 3 * 60 * MIN }, { remaining: 80, resetsAt: now + 9 * 60 * MIN, runsOutAt: now + 90 * MIN });
    const why = route(task(), ctx([account({ id: 'a' })], { usage: { a: both }, now })).candidates[0]!.why.join(' ');
    expect(why).toMatch(/runs out in about 1 h 30 min/);
    expect(why).not.toMatch(/resets in/);
  });
});
