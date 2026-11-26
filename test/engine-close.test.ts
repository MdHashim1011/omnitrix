import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { takeSeat } from '../src/seats.js';
import { files } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// An engine with one job running on a slow account and one waiting for its only seat.
async function busyEngine() {
  tempHome();
  const slow = await mockProvider(() => ({ json: chatReply('late'), delayMs: 3000 }));
  closers.push(slow.close);
  writeConfig([account({ id: 'shared', baseUrl: slow.url, local: true, concurrency: 1 })]);
  const engine = new Engine();
  const jobs = engine.dispatch([{ title: 'one', type: 'writing', prompt: 'first' }, { title: 'two', type: 'writing', prompt: 'second' }]);
  while (engine.getJob(jobs[0]!.id)!.status !== 'running') await pause(10);
  expect(engine.getJob(jobs[1]!.id)!.status).toBe('queued');
  return { engine, jobs };
}

// An engine whose only job waits for the account's one seat, held by a job of another process in this data
// folder; in any other data folder the seat is free, so the job would start at once.
async function waitingEngine() {
  tempHome();
  writeConfig([account({ id: 'shared', local: true, concurrency: 1 })]);
  expect(takeSeat('shared', 1, 'jotherholder1')).toBeDefined();
  const engine = new Engine();
  const [job] = engine.dispatch([{ title: 'waits', type: 'writing', prompt: 'leftover' }]);
  await pause(50);
  expect(engine.getJob(job!.id)!.status).toBe('queued');
}

// The next test's data folder, with an account of the same name on a server of its own.
async function nextHome() {
  tempHome();
  const fresh = await mockProvider(() => ({ json: chatReply('fresh') }));
  closers.push(fresh.close);
  writeConfig([account({ id: 'shared', baseUrl: fresh.url, local: true, concurrency: 1 })]);
  return fresh;
}

describe('closing an engine', () => {
  it('cancels its unfinished jobs and starts nothing in the data folder a later test sets', async () => {
    const { engine, jobs } = await busyEngine();
    await engine.close();
    expect(jobs.map((j) => engine.getJob(j.id)!.status)).toEqual(['cancelled', 'cancelled']);
    const fresh = await nextHome();
    // the engine ticked every second while it was open
    await pause(2500);
    expect(fresh.calls).toHaveLength(0);
    expect(fs.existsSync(files.jobs()) ? fs.readdirSync(files.jobs()) : []).toEqual([]);
  });

  // These two run in order: the first leaves its engine open, as most tests do, and the second checks that
  // the shared cleanup in test/setup.ts closed it before the second began.
  it('leaves an engine open with a job waiting for a seat', async () => {
    await waitingEngine();
  });

  it('does not let the engine of an earlier test run its leftover job on this test\'s accounts', async () => {
    const fresh = await nextHome();
    await pause(2500);
    expect(fresh.calls).toHaveLength(0);
  });
});
