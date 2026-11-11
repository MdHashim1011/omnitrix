import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { freeSeat, takeSeat } from '../src/seats.js';
import { files } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const closers: (() => unknown)[] = [];
beforeEach(() => tempHome());
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('account seats', () => {
  it('hands out no more seats than the limit, and frees them again', () => {
    const a = takeSeat('acc', 2, 'j1');
    const b = takeSeat('acc', 2, 'j2');
    expect(a && b).toBeTruthy();
    expect(takeSeat('acc', 2, 'j3')).toBeUndefined();
    freeSeat(a);
    expect(takeSeat('acc', 2, 'j3')).toBeTruthy();
  });

  it('reclaims a seat held by a process that died', () => {
    const dir = path.join(files.seats(), 'acc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2000000000-jdead'), '');
    expect(takeSeat('acc', 1, 'j1')).toBeTruthy();
    expect(fs.existsSync(path.join(dir, '2000000000-jdead'))).toBe(false);
  });

  it('frees a seat whose pid now belongs to an unrelated process', async () => {
    const { writeJson } = await import('../src/store.js');
    const dir = path.join(files.seats(), 'acc');
    fs.mkdirSync(dir, { recursive: true });
    // the seat names a live pid (ours), but its job record says it finished long ago
    fs.writeFileSync(path.join(dir, `${process.pid}-jold`), '');
    writeJson(path.join(files.jobs(), 'jold.json'), { id: 'jold', status: 'done', pid: process.pid });
    expect(takeSeat('acc', 1, 'j1')).toBeTruthy();
  });

  it('gives up quickly on a busy lock and lets the next pass retry', () => {
    const dir = path.join(files.seats(), 'acc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.lock'), String(process.pid));
    const started = Date.now();
    expect(takeSeat('acc', 1, 'j1')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('does not remove a lock it no longer owns', () => {
    const dir = path.join(files.seats(), 'acc');
    fs.mkdirSync(dir, { recursive: true });
    // simulate another process replacing our lock while we hold it: takeSeat must leave theirs in place
    const real = fs.writeFileSync;
    let seatWritten = false;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: unknown, opts?: unknown) => {
      real(file, data as string, opts as never);
      if (!seatWritten && String(file).includes('-j1')) {
        seatWritten = true;
        real(path.join(dir, '.lock'), 'someone-else');
      }
    }) as typeof fs.writeFileSync);
    expect(takeSeat('acc', 1, 'j1')).toBeTruthy();
    spy.mockRestore();
    expect(fs.readFileSync(path.join(dir, '.lock'), 'utf8')).toBe('someone-else');
  });

  it('breaks a lock left by a crashed process', () => {
    const dir = path.join(files.seats(), 'acc');
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, '.lock');
    fs.writeFileSync(lock, '2000000000');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lock, old, old);
    expect(takeSeat('acc', 1, 'j1')).toBeTruthy();
  });

  it('waits out a lock that a live process holds', () => {
    const dir = path.join(files.seats(), 'acc');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.lock'), String(process.pid));
    expect(takeSeat('acc', 1, 'j1')).toBeUndefined();
  });
});

describe('concurrency across engines', () => {
  it('runs one job at a time on a concurrency-1 account even from two engines', async () => {
    let inFlight = 0;
    let peak = 0;
    const p = await mockProvider(() => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => inFlight--, 600);
      return { json: chatReply('ok'), delayMs: 600 };
    });
    closers.push(p.close);
    writeConfig([account({ id: 'one', baseUrl: p.url, local: true, concurrency: 1 })]);
    const a = new Engine();
    const b = new Engine();
    const [first] = a.dispatch([{ title: 'a', type: 'bulk', prompt: 'a' }]);
    await new Promise((r) => setTimeout(r, 100));
    const [second] = b.dispatch([{ title: 'b', type: 'bulk', prompt: 'b' }]);
    expect(b.getJob(second!.id)!.status).toBe('queued');
    const [doneA] = await a.wait([first!.id], 5);
    const [doneB] = await b.wait([second!.id], 5);
    expect(doneA!.status).toBe('done');
    expect(doneB!.status).toBe('done');
    expect(peak).toBe(1);
    expect(fs.readdirSync(path.join(files.seats(), 'one')).filter((n) => n !== '.lock')).toEqual([]);
  });
});
