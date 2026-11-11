import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { files, readJson, writeJson } from '../src/store.js';
import type { Job } from '../src/types.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const closers: (() => unknown)[] = [];
beforeEach(() => tempHome());
afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length) await closers.pop()!();
});

function busy(code: string) {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

describe('writeJson', () => {
  it('retries a refused rename instead of writing the file in place', () => {
    const file = path.join(process.env.OMNITRIX_HOME!, 'x.json');
    writeJson(file, { v: 1 });
    const real = fs.renameSync;
    let refused = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (refused++ < 2) throw busy('EPERM');
      real(from, to);
    });
    const direct = vi.spyOn(fs, 'writeFileSync');
    writeJson(file, { v: 2 });
    expect(readJson(file, null)).toEqual({ v: 2 });
    // the only write goes to the temp file; the target is never truncated and rewritten
    expect(direct.mock.calls.every(([target]) => String(target) !== file)).toBe(true);
  });

  it('keeps the old file and leaves no temp file when the rename never succeeds', () => {
    const file = path.join(process.env.OMNITRIX_HOME!, 'y.json');
    writeJson(file, { v: 1 });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw busy('EBUSY');
    });
    expect(() => writeJson(file, { v: 2 })).toThrow(/EBUSY/);
    vi.restoreAllMocks();
    expect(readJson(file, null)).toEqual({ v: 1 });
    expect(fs.readdirSync(process.env.OMNITRIX_HOME!).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('jobs owned by another process', () => {
  let other: ChildProcess | undefined;
  afterEach(() => {
    other?.kill();
    other = undefined;
  });

  function liveForeignPid(): number {
    other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    return other.pid!;
  }

  function writeJob(over: Partial<Job>): Job {
    const now = Date.now();
    const job: Job = { id: `jtest${Math.random().toString(36).slice(2, 8)}`, task: { title: 't', type: 'writing', prompt: 'q' }, status: 'running', createdAt: now, updatedAt: now, attempts: [], ...over };
    writeJson(path.join(files.jobs(), `${job.id}.json`), job);
    return job;
  }

  it('asks the live owner to cancel and leaves its job record alone', () => {
    writeConfig([account({ id: 'a' })]);
    const job = writeJob({ pid: liveForeignPid() });
    const engine = new Engine();
    expect(engine.cancel(job.id)).toBe(true);
    expect(fs.existsSync(path.join(files.jobs(), `${job.id}.cancel`))).toBe(true);
    expect(readJson<Job | null>(path.join(files.jobs(), `${job.id}.json`), null)!.status).toBe('running');
  });

  it('cancels directly when the owner is gone', () => {
    writeConfig([account({ id: 'a' })]);
    const engine = new Engine();
    // written after the engine started, so startup recovery has not seen it
    const job = writeJob({ pid: 2_000_000_000 });
    expect(engine.cancel(job.id)).toBe(true);
    expect(readJson<Job | null>(path.join(files.jobs(), `${job.id}.json`), null)!.status).toBe('cancelled');
  });

  it('reads the latest state of a job another process owns', () => {
    writeConfig([account({ id: 'a' })]);
    const job = writeJob({ pid: liveForeignPid() });
    const engine = new Engine();
    writeJson(path.join(files.jobs(), `${job.id}.json`), { ...job, status: 'done', updatedAt: Date.now() });
    expect(engine.getJob(job.id)!.status).toBe('done');
  });

  it('owner stops its own job when it finds a cancel request', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok'), delayMs: 5000 }));
    closers.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true, concurrency: 1 })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'slow', type: 'bulk', prompt: 'x' }]);
    fs.writeFileSync(path.join(files.jobs(), `${job!.id}.cancel`), '');
    const [after] = await engine.wait([job!.id], 4);
    expect(after!.status).toBe('cancelled');
    expect(fs.existsSync(path.join(files.jobs(), `${job!.id}.cancel`))).toBe(false);
  });

  it('marks a job interrupted even when its dead owner stopped days ago, keeping its age', () => {
    writeConfig([account({ id: 'a' })]);
    const old = Date.now() - 5 * 24 * 3600_000;
    const job = writeJob({ pid: 2_000_000_000, updatedAt: old });
    new Engine();
    const saved = readJson<Job | null>(path.join(files.jobs(), `${job.id}.json`), null)!;
    expect(saved.status).toBe('failed');
    expect(saved.error).toMatch(/interrupted/);
    expect(saved.updatedAt).toBe(old);
  });

  it('removes a cancel note that arrives after its job finished', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok') }));
    closers.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'fast', type: 'bulk', prompt: 'x' }]);
    await engine.wait([job!.id], 5);
    const note = path.join(files.jobs(), `${job!.id}.cancel`);
    fs.writeFileSync(note, '');
    await new Promise((r) => setTimeout(r, 1500));
    expect(fs.existsSync(note)).toBe(false);
    expect(engine.getJob(job!.id)!.status).toBe('done');
  });

  it('saves a finished job once the file is no longer locked', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok'), delayMs: 300 }));
    closers.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'locked', type: 'bulk', prompt: 'x' }]);
    const file = path.join(files.jobs(), `${job!.id}.json`);
    const lock = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw busy('EBUSY');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await engine.wait([job!.id], 5);
    expect(readJson<Job | null>(file, null)!.status).not.toBe('done');
    lock.mockRestore();
    await new Promise((r) => setTimeout(r, 1500));
    expect(readJson<Job | null>(file, null)!.status).toBe('done');
  });
});
