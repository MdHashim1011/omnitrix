import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { OWNER, ownerAlive } from '../src/owner.js';
import { takeSeat } from '../src/seats.js';
import { files, readJson, writeJson } from '../src/store.js';
import type { Job } from '../src/types.js';
import { account, tempHome, writeConfig } from './helpers.js';

beforeEach(() => tempHome());

// A process id is reused once its process exits. These jobs carry the live pid of this test process,
// but an owner token whose heartbeat is missing, which is what a reused pid looks like.
const deadOwner = `${process.pid}.deadbeef`;

function writeJob(over: Partial<Job>): Job {
  const now = Date.now();
  const job: Job = { id: `jown${Math.random().toString(36).slice(2, 8)}`, task: { title: 't', type: 'writing', prompt: 'q' }, status: 'running', createdAt: now, updatedAt: now, attempts: [], ...over };
  writeJson(path.join(files.jobs(), `${job.id}.json`), job);
  return job;
}

function heartbeat(owner: string, ageMs = 0): void {
  fs.mkdirSync(files.owners(), { recursive: true });
  const file = path.join(files.owners(), owner);
  fs.writeFileSync(file, '');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

describe('job owners', () => {
  it('marks a job interrupted when its pid was reused by another process', () => {
    writeConfig([account({ id: 'a' })]);
    const job = writeJob({ pid: process.pid, owner: deadOwner });
    new Engine();
    expect(readJson<Job | null>(path.join(files.jobs(), `${job.id}.json`), null)!.status).toBe('failed');
  });

  it('does not treat a job left under a reused pid as its own', () => {
    writeConfig([account({ id: 'a' })]);
    const engine = new Engine();
    const job = writeJob({ pid: process.pid, owner: deadOwner });
    expect(engine.cancel(job.id)).toBe(true);
    // a dead owner is cancelled directly instead of waiting on a controller that does not exist
    expect(readJson<Job | null>(path.join(files.jobs(), `${job.id}.json`), null)!.status).toBe('cancelled');
  });

  it('leaves a cancel note for an owner whose heartbeat is fresh', () => {
    writeConfig([account({ id: 'a' })]);
    const owner = `${process.pid}.cafe0001`;
    heartbeat(owner);
    const engine = new Engine();
    const job = writeJob({ pid: process.pid, owner });
    expect(engine.cancel(job.id)).toBe(true);
    expect(fs.existsSync(path.join(files.jobs(), `${job.id}.cancel`))).toBe(true);
  });

  it('counts an owner with a stale heartbeat as gone', () => {
    const owner = `${process.pid}.cafe0002`;
    heartbeat(owner, 60_000);
    expect(ownerAlive(owner, process.pid)).toBe(false);
    heartbeat(owner);
    expect(ownerAlive(owner, process.pid)).toBe(true);
  });

  it('frees a seat whose job belongs to a dead owner', () => {
    const dir = path.join(files.seats(), 'acc');
    fs.mkdirSync(dir, { recursive: true });
    const job = writeJob({ pid: process.pid, owner: deadOwner });
    fs.writeFileSync(path.join(dir, `${process.pid}-${job.id}`), '');
    expect(takeSeat('acc', 1, 'j1')).toBeTruthy();
  });

  it('drops finished jobs older than a day from memory but can still read them', async () => {
    writeConfig([account({ id: 'a' })]);
    const old = writeJob({ status: 'done', pid: process.pid, owner: OWNER, updatedAt: Date.now() - 2 * 24 * 3600_000 });
    const engine = new Engine();
    const memory = (engine as unknown as { jobs: Map<string, Job> }).jobs;
    expect(memory.has(old.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(memory.has(old.id)).toBe(false);
    expect(engine.getJob(old.id)?.status).toBe('done');
  });

  it('stamps new jobs with this process and keeps its heartbeat fresh', async () => {
    writeConfig([account({ id: 'a' })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q', privacy: 'secret' }]);
    expect(job!.owner).toBe(OWNER);
    const first = fs.statSync(path.join(files.owners(), OWNER)).mtimeMs;
    // check that the heartbeat moved on, not how fast; slow CI machines break time limits
    await new Promise((r) => setTimeout(r, 2500));
    expect(fs.statSync(path.join(files.owners(), OWNER)).mtimeMs).toBeGreaterThan(first);
    expect(ownerAlive(OWNER, process.pid)).toBe(true);
  });
});
