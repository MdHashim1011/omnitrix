import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { loadQuotas } from '../src/quota.js';
import { loadStats } from '../src/stats.js';
import { files, saveHealth, setSecret } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const closers: (() => unknown)[] = [];
beforeEach(() => {
  tempHome();
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function oneJob(reply = 'answer') {
  const p = await mockProvider(() => ({ json: chatReply(reply) }));
  closers.push(p.close);
  setSecret('a', 'sk-test-123456789012345');
  setSecret('b', 'sk-test-123456789012345');
  writeConfig([account({ id: 'a', baseUrl: p.url, apiKey: 'secret' }), account({ id: 'b', baseUrl: p.url, apiKey: 'secret' })]);
  const engine = new Engine();
  const [job] = engine.dispatch([{ title: 'read', type: 'review', prompt: 'p' }]);
  const [done] = await engine.wait([job!.id], 10);
  return { engine, job: done! };
}

describe('the pool view agrees with the router', () => {
  it('shows an account without requests left, or without models, as unable to take work', () => {
    writeConfig([account({ id: 'empty', models: [] }), account({ id: 'spent' })]);
    saveHealth({ spent: { state: 'ready', measured: { remainingRequests: 0, at: Date.now(), source: 'response headers' } } });
    const pool = new Engine().pool();
    expect(pool.find((a) => a.id === 'empty')!.state).not.toBe('ready');
    expect(pool.find((a) => a.id === 'spent')!.state).toBe('exhausted');
  });
});

describe('a damaged quota file', () => {
  it('is read as no reading instead of breaking the pool view', () => {
    writeConfig([account({ id: 'a' })]);
    fs.mkdirSync(files.jobs(), { recursive: true });
    fs.writeFileSync(files.quota(), JSON.stringify({ a: { at: 'soon', windows: [{ name: '<b>x</b>', usedPercent: 'lots' }] }, b: null, c: { at: 1, windows: 'none' } }));
    expect(loadQuotas()).toEqual({});
    expect(() => new Engine().pool()).not.toThrow();
  });
});

describe('rating a result', () => {
  it('counts one verdict per job, and a changed mind moves the count instead of adding one', async () => {
    const { engine, job } = await oneJob();
    engine.verdict(job.id, true);
    engine.verdict(job.id, true);
    let cell = Object.values(loadStats())[0]!;
    expect(cell.ok).toBeCloseTo(1, 3);
    expect(cell.bad).toBeCloseTo(0, 3);
    engine.verdict(job.id, false, 'wrong after all');
    cell = Object.values(loadStats())[0]!;
    expect(cell.ok).toBeCloseTo(0, 3);
    expect(cell.bad).toBeCloseTo(1, 3);
  });

  it('retries a rejected job once, and never retries a check', async () => {
    const { engine, job } = await oneJob();
    const again = engine.retry(job.id, 'missed the point');
    expect(again).toBeDefined();
    expect(engine.retry(job.id, 'and again')).toBeUndefined();
    await engine.wait([again!.id], 10);
    const [checked] = engine.dispatch([{ title: 'c', type: 'review', prompt: 'p' }], { checkOf: again!.id });
    const [doneCheck] = await engine.wait([checked!.id], 10);
    expect(doneCheck!.status).toBe('done');
    expect(engine.retry(checked!.id, 'not a real check')).toBeUndefined();
  });
});

describe('the status line', () => {
  it('does not count an account with no requests left as ready', async () => {
    const { renderStatusLine } = await import('../src/statusline.js');
    writeConfig([account({ id: 'spent' }), account({ id: 'fine' })]);
    saveHealth({ spent: { state: 'ready', measured: { remainingRequests: 0, at: Date.now(), source: 'response headers' } } });
    expect(renderStatusLine('')).toMatch(/omnitrix 1\/2 ready/);
  });
});
