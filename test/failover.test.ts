import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { jobView } from '../src/mcp.js';
import { makeModel } from '../src/models.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
beforeEach(() => tempHome());
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const outOfCredit = { status: 429, json: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota' } } };
const task = { title: 't', type: 'writing' as const, prompt: 'Say hi.' };

/** A provider that gives the answers in `replies` in turn, then the last one for good. */
async function provider(replies: { status?: number; headers?: Record<string, string>; json: unknown }[]) {
  const p = await mockProvider((_req, n) => replies[Math.min(n, replies.length) - 1]!);
  cleanups.push(p.close);
  return p;
}

describe('a job keeps moving while any account can take it', () => {
  it('does not count accounts that are out of quota against its attempts', async () => {
    // free keys run out quickly; three empty ones must not stop a job that a fourth key can do
    const empty = await Promise.all([1, 2, 3].map(() => provider([outOfCredit])));
    const good = await provider([{ json: chatReply('hi') }]);
    writeConfig([
      ...empty.map((p, i) => account({ id: `empty${i}`, baseUrl: p.url, local: true, models: [makeModel('big-model-70b')] })),
      account({ id: 'good', baseUrl: good.url, local: true, models: [makeModel('small-model-1b')] }),
    ]);
    const engine = new Engine();
    const [job] = engine.dispatch([task]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'good' });
    expect(done!.attempts.map((a) => a.errorKind ?? 'ok')).toEqual(['quota', 'quota', 'quota', 'ok']);
  });

  it('waits for a short rate limit when no other account can take the task, then runs it', async () => {
    const p = await provider([{ status: 429, headers: { 'retry-after': '1' }, json: { error: { message: 'Rate limit reached for requests per minute' } } }, { json: chatReply('hi') }]);
    writeConfig([account({ id: 'only', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const [job] = engine.dispatch([task]);
    // while it waits it is queued, says until when, and has not failed
    await new Promise((r) => setTimeout(r, 300));
    const waiting = engine.getJob(job!.id)!;
    expect(waiting.status).toBe('queued');
    expect(jobView(waiting, false, engine).waiting).toMatch(/resting.*tries again at/);
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'only' });
    expect(done!.attempts.map((a) => a.errorKind ?? 'ok')).toEqual(['rate_limit', 'ok']);
    expect(jobView(done!, false, engine).waiting).toBeUndefined();
    expect(done!.waitingUntil).toBeUndefined();
  });

  it('fails at once with the reason when the soonest account is back only much later', async () => {
    const p = await provider([{ status: 429, headers: { 'retry-after': '600' }, json: { error: { message: 'Rate limit reached for requests per minute' } } }]);
    writeConfig([account({ id: 'only', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const [job] = engine.dispatch([task]);
    const started = Date.now();
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('does not wait for an account that could not take the task anyway', async () => {
    // a secret task may only go to this computer; a cloud account coming back soon does not help it
    const cloud = await provider([{ json: chatReply('hi') }]);
    writeConfig([account({ id: 'cloud', baseUrl: cloud.url })]);
    const engine = new Engine();
    const health = { cloud: { state: 'cooling' as const, until: Date.now() + 5000, reason: 'rate limited' } };
    (await import('../src/store.js')).saveHealth(health);
    const [job] = engine.dispatch([{ ...task, privacy: 'secret' as const }]);
    const started = Date.now();
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(done!.error).toMatch(/secret task: local models only/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('gets past more empty keys than a job has tries, but not past any number', async () => {
    const empty = await provider([outOfCredit]);
    const good = await provider([{ json: chatReply('hi') }]);
    const emptyKeys = (n: number) => Array.from({ length: n }, (_, i) => account({ id: `empty${i}`, baseUrl: empty.url, local: true, models: [makeModel('big-model-70b')] }));
    writeConfig([...emptyKeys(13), account({ id: 'good', baseUrl: good.url, local: true, models: [makeModel('small-model-1b')] })]);
    const first = new Engine();
    const [job] = first.dispatch([task]);
    const [done] = await first.wait([job!.id], 20);
    expect(done).toMatchObject({ status: 'done', accountId: 'good' });
    expect(done!.attempts.filter((a) => a.errorKind === 'quota')).toHaveLength(13);

    tempHome();
    writeConfig(emptyKeys(30));
    const engine = new Engine();
    const [lost] = engine.dispatch([task]);
    const [failed] = await engine.wait([lost!.id], 20);
    expect(failed!.status).toBe('failed');
    expect(failed!.attempts).toHaveLength(24);
  }, 30_000);

  it('waits through a model rest that the rest of its account hid', async () => {
    const p = await provider([{ json: chatReply('hi') }]);
    writeConfig([account({ id: 'only', baseUrl: p.url, local: true, models: [makeModel('small-model-1b')] })]);
    const now = Date.now();
    (await import('../src/store.js')).saveHealth({
      only: { state: 'cooling', until: now + 600, reason: 'rate limited' },
      'only/small-model-1b': { state: 'cooling', until: now + 1500, reason: 'overloaded' },
    });
    const engine = new Engine();
    const [job] = engine.dispatch([task]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'only' });
    expect(Date.now() - now).toBeGreaterThanOrEqual(1500);
  });

  it('names what still stops a model when its whole account rests for long', async () => {
    const p = await provider([{ json: chatReply('hi') }]);
    writeConfig([account({ id: 'box', baseUrl: p.url, local: true, models: [makeModel('gpt-oss:20b-cloud')] })]);
    (await import('../src/store.js')).saveHealth({ box: { state: 'cooling', until: Date.now() + 600_000, reason: 'rate limited' } });
    const engine = new Engine();
    const [job] = engine.dispatch([{ ...task, privacy: 'secret' as const }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(done!.error).toMatch(/box\/gpt-oss:20b-cloud: secret task: this model runs in the cloud/);
    expect(done!.error).not.toMatch(/cooling until/);
  });

  it('still stops after three failures that are the models\' own', async () => {
    const broken = await Promise.all([1, 2, 3, 4].map(() => provider([{ status: 400, json: { error: { message: 'something odd' } } }])));
    writeConfig(broken.map((p, i) => account({ id: `odd${i}`, baseUrl: p.url, local: true })));
    const engine = new Engine();
    const [job] = engine.dispatch([task]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(done!.attempts.length).toBeLessThanOrEqual(3);
  });
});
