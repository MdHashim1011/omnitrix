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
