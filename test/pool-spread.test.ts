import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine, waitsForStronger } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { route, type RouteContext } from '../src/router.js';
import { files, loadConfig, setSecret } from '../src/store.js';
import fs from 'node:fs';
import type { TaskType } from '../src/types.js';
import type { UsageSummary } from '../src/usage.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// From the owner's 40-package test: a ChatGPT Plus plan (Codex) and a free Gemini key were both working, yet
// nearly every task went to Gemini. These tests rebuild that pool with fake providers.

const now = Date.UTC(2026, 10, 26, 12);
const chatgpt = account({ id: 'chatgpt', provider: 'openai', models: [makeModel('gpt-6.2-sol')], concurrency: 1 });
const gemini = account({ id: 'gemini', provider: 'gemini', trainsOnData: true, models: [makeModel('gemini-3-flash-preview')], concurrency: 2 });

function usage(id: string, extra: Partial<UsageSummary>): UsageSummary {
  return { accountId: id, requestsToday: 0, failedToday: 0, tokensToday: 0, tokensMonth: 0, costToday: 0, windows: [], source: 'untracked', ...extra };
}
// the plan as Codex reports it: the week 45% used, and the 5-hour window filling fast during a big run
const planHalfUsed = usage('chatgpt', {
  source: 'measured',
  percentUsed: 45,
  windows: [
    { name: '5 hours', unit: 'percent', used: 30, limit: 100, remaining: 70, resetsAt: now + 4 * 3600_000, runsOutAt: now + 2 * 3600_000 },
    { name: 'weekly', unit: 'percent', used: 45, limit: 100, remaining: 55, resetsAt: now + 3 * 86400_000 },
  ],
});
const freeKey = usage('gemini', { source: 'estimated', percentUsed: 8, windows: [{ name: '24 hours', unit: 'requests', used: 20, limit: 250, remaining: 230 }] });

function ctx(chatgptUsage = planHalfUsed): RouteContext {
  return {
    config: { version: 1, accounts: [chatgpt, gemini], settings: writeConfig([chatgpt, gemini]).settings },
    health: {},
    usage: { chatgpt: chatgptUsage, gemini: freeKey },
    running: {},
    stats: {},
    now,
  };
}
const task = (type: TaskType, privacy: 'public' | 'private' = 'public') => ({ title: 't', type, prompt: 'p', privacy });

beforeEach(() => {
  tempHome();
});

describe('accuracy first: the strongest account gets hard work', () => {
  it('ranks the plan model first for hard work while its quota is far from empty', () => {
    for (const type of ['review', 'reasoning', 'code_snippet'] as const) {
      for (const privacy of ['public', 'private'] as const) {
        const first = route(task(type, privacy), ctx()).candidates[0]!;
        expect(`${type}/${privacy}: ${first.accountId}`).toBe(`${type}/${privacy}: chatgpt`);
      }
    }
  });

  it('still moves work off an account that is nearly out of quota', () => {
    const low = usage('chatgpt', { source: 'measured', percentUsed: 92, windows: [{ name: 'weekly', unit: 'percent', used: 92, limit: 100, remaining: 8 }] });
    expect(route(task('review'), ctx(low)).candidates[0]!.accountId).toBe('gemini');
  });

  it('tells how strong each candidate is for the task, apart from quota and timing', () => {
    const { candidates } = route(task('review'), ctx());
    const by = Object.fromEntries(candidates.map((c) => [c.accountId, c.strength]));
    expect(by.chatgpt).toBeCloseTo(0.8, 2);
    expect(by.gemini).toBeLessThan(by.chatgpt!);
  });
});

describe('a batch of tasks over the pool', () => {
  let closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers) await c();
    closers = [];
  });

  async function pool(strongSeats: number) {
    const strong = await mockProvider(() => ({ json: chatReply('strong answer'), delayMs: 120 }));
    const weak = await mockProvider(() => ({ json: chatReply('weak answer'), delayMs: 20 }));
    closers.push(strong.close, weak.close);
    setSecret('chatgpt', 'sk-test-strong-0000000000');
    setSecret('gemini', 'sk-test-weak-00000000000');
    writeConfig([{ ...chatgpt, baseUrl: strong.url, concurrency: strongSeats, apiKey: 'secret' }, { ...gemini, baseUrl: weak.url, apiKey: 'secret' }]);
    return new Engine();
  }

  it('keeps hard work for the stronger account, waiting for its seat rather than handing it to a much weaker model', async () => {
    const engine = await pool(1);
    const jobs = engine.dispatch(Array.from({ length: 6 }, (_, i) => ({ ...task('review'), title: `review ${i}` })));
    const done = await engine.wait(jobs.map((j) => j.id), 20);
    expect(done.map((j) => j.status + " " + (j.error ?? ""))).toEqual(Array(6).fill("done "));
    expect(done.map((j) => j.accountId)).toEqual(Array(6).fill('chatgpt'));
  });

  it('uses every account at once for work they do about equally well', async () => {
    const engine = await pool(1);
    const jobs = engine.dispatch(Array.from({ length: 6 }, (_, i) => ({ ...task('bulk'), title: `bulk ${i}` })));
    const done = await engine.wait(jobs.map((j) => j.id), 20);
    expect(new Set(done.map((j) => j.accountId))).toEqual(new Set(['chatgpt', 'gemini']));
  });

  it('spreads hard work too when finishing soon was asked for', async () => {
    const engine = await pool(1);
    const jobs = engine.dispatch(Array.from({ length: 6 }, (_, i) => ({ ...task('review'), title: `fast review ${i}`, route: 'fast' })));
    const done = await engine.wait(jobs.map((j) => j.id), 20);
    expect(new Set(done.map((j) => j.accountId))).toEqual(new Set(['chatgpt', 'gemini']));
  });

  it('says why a job waits while a weaker account is free', async () => {
    const engine = await pool(1);
    const jobs = engine.dispatch(Array.from({ length: 3 }, (_, i) => ({ ...task('review'), title: `review ${i}` })));
    const waiting = jobs.map((j) => engine.getJob(j.id)!).filter((j) => j.status === 'queued');
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting[0]!.waitingFor).toMatch(/^chatgpt, which is stronger/);
    await engine.wait(jobs.map((j) => j.id), 20);
    expect(engine.getJob(jobs[2]!.id)!.waitingFor).toBeUndefined();
  });
});

describe('a job never waits for a stronger account without end', () => {
  let closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers) await c();
    closers = [];
  });

  // the strong account stays busy with a long job, as when another process or a big task holds its seat
  async function busyPool() {
    const strong = await mockProvider(() => ({ json: chatReply('strong answer'), delayMs: 4000 }));
    const weak = await mockProvider(() => ({ json: chatReply('weak answer'), delayMs: 20 }));
    closers.push(strong.close, weak.close);
    setSecret('chatgpt', 'sk-test-strong-0000000000');
    setSecret('gemini', 'sk-test-weak-00000000000');
    writeConfig([{ ...chatgpt, baseUrl: strong.url, apiKey: 'secret' }, { ...gemini, baseUrl: weak.url, apiKey: 'secret' }]);
    const engine = new Engine();
    const [hold, job] = engine.dispatch([{ ...task('review'), title: 'long' }, { ...task('review'), title: 'next' }]);
    expect(engine.getJob(job!.id)!.status).toBe('queued');
    return { engine, hold: hold!, job: engine.getJob(job!.id)! };
  }

  it('takes a free account once it has waited ten minutes', async () => {
    const { engine, hold, job } = await busyPool();
    job.createdAt -= 11 * 60_000;
    const [done] = await engine.wait([job.id], 3);
    expect(`${done!.status}@${done!.accountId}`).toBe('done@gemini');
    engine.cancel(hold.id);
  });

  it('does not wait for an account that just failed this job with a server error', async () => {
    const { engine, hold, job } = await busyPool();
    job.attempts.push({ accountId: 'chatgpt', model: 'gpt-6.2-sol', startedAt: Date.now(), endedAt: Date.now(), ok: false, errorKind: 'server', error: '500' });
    const [done] = await engine.wait([job.id], 3);
    expect(`${done!.status}@${done!.accountId}`).toBe('done@gemini');
    engine.cancel(hold.id);
  });
});

describe('which jobs wait for a stronger account', () => {
  it('waits only when accuracy matters more than speed or cost', () => {
    const s = writeConfig([chatgpt, gemini]).settings;
    expect(waitsForStronger(task('review'), s)).toBe(true);
    expect(waitsForStronger({ ...task('review'), route: 'deep' }, s)).toBe(true);
    expect(waitsForStronger({ ...task('review'), route: 'fast' }, s)).toBe(false);
    expect(waitsForStronger({ ...task('review'), fast: true }, s)).toBe(false);
    expect(waitsForStronger({ ...task('review'), route: 'cheap' }, s)).toBe(false);
    expect(waitsForStronger({ ...task('review'), escalate: true }, s)).toBe(false);
    expect(waitsForStronger(task('bulk'), s)).toBe(false);
    expect(waitsForStronger(task('review'), { ...s, mode: 'saver' })).toBe(false);
  });
});

describe('an account without a valid job limit', () => {
  it('runs one job at a time instead of without any limit', () => {
    writeConfig([chatgpt, gemini]);
    const raw = JSON.parse(fs.readFileSync(files.config(), 'utf8'));
    delete raw.accounts[0].concurrency;
    raw.accounts[1].concurrency = '3';
    fs.writeFileSync(files.config(), JSON.stringify(raw));
    expect(loadConfig().accounts.map((a) => a.concurrency)).toEqual([1, 1]);
    expect(new Engine().pool().map((a) => a.seats)).toEqual([1, 1]);
  });
});
