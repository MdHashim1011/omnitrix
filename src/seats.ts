// Seats cap how many jobs run on one account at once, across every omnitrix process on this computer.
// Each running job holds an empty file named `<pid>-<job id>` in the account's folder.
import fs from 'node:fs';
import path from 'node:path';
import { files, processAlive, readJson, slug } from './store.js';
import type { Job } from './types.js';

const pause = new Int32Array(new SharedArrayBuffer(4));
// Windows reports a file that is being deleted as EPERM, EBUSY or EACCES rather than EEXIST.
const BUSY = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);

function remove(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // still held open on Windows; the next pass cleans it up
  }
}

/**
 * Counting the seats and taking one must happen as one step, or two processes could both see a free
 * seat. A lock file made with an exclusive create gives that; it is held only for a few file operations.
 * After 10 tries (about 100 ms) this gives up and the caller tries again on its next pass.
 */
function withLock<T>(dir: string, fn: () => T): T | undefined {
  const lock = path.join(dir, '.lock');
  const mark = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.writeFileSync(lock, mark, { flag: 'wx' });
    } catch (err) {
      if (!BUSY.has((err as NodeJS.ErrnoException).code ?? '')) return undefined;
      breakIfStale(lock);
      Atomics.wait(pause, 0, 0, 10);
      continue;
    }
    try {
      return fn();
    } finally {
      // only remove our own lock; if ours was broken as stale, the file now belongs to someone else
      try {
        if (fs.readFileSync(lock, 'utf8') === mark) remove(lock);
      } catch {
        // already gone
      }
    }
  }
  return undefined;
}

/**
 * A lock this old means its holder crashed or hung. A younger one may still be mid-write, with no pid
 * in it yet, so it is never broken. The age is checked again right before removing, so a fresh lock
 * that replaced the stale one in between is left alone.
 */
function breakIfStale(lock: string): void {
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    const holder = Number(fs.readFileSync(lock, 'utf8').split('-')[0]);
    if (age <= 2000 || (processAlive(holder) && age <= 10_000)) return;
    if (Date.now() - fs.statSync(lock).mtimeMs > 2000) remove(lock);
  } catch {
    // released meanwhile
  }
}

/**
 * A seat still counts while its process is alive and its job has not moved on. Checking the job record
 * as well frees a seat whose pid was reused by an unrelated process.
 */
function seatHeld(name: string): boolean {
  const dash = name.indexOf('-');
  const pid = Number(name.slice(0, dash));
  if (!processAlive(pid)) return false;
  const job = readJson<Job | null>(path.join(files.jobs(), `${name.slice(dash + 1)}.json`), null);
  if (!job) return true;
  return job.pid === pid && (job.status === 'queued' || job.status === 'running');
}

/** Returns the seat to pass to freeSeat, or undefined when the account is full (or the lock is busy). */
export function takeSeat(accountId: string, limit: number, jobId: string): string | undefined {
  const dir = path.join(files.seats(), slug(accountId));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  try {
    return withLock(dir, () => {
      let taken = 0;
      for (const name of fs.readdirSync(dir)) {
        if (name === '.lock') continue;
        if (seatHeld(name)) taken++;
        else remove(path.join(dir, name));
      }
      if (taken >= limit) return undefined;
      const seat = path.join(dir, `${process.pid}-${jobId}`);
      fs.writeFileSync(seat, '');
      return seat;
    });
  } catch {
    return undefined;
  }
}

export function freeSeat(seat: string | undefined): void {
  if (seat) remove(seat);
}
