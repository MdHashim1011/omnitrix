// Who owns a job. A pid alone is not enough, because the operating system reuses it after a process
// exits; Windows does so quickly. Each process therefore has a random owner token and keeps a heartbeat
// file named after it fresh. An owner is alive while its pid exists and its heartbeat is recent.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { files, processAlive } from './store.js';

export const OWNER = `${process.pid}.${randomUUID().slice(0, 8)}`;

// Generous next to the one-second beat, so a process busy with a long synchronous step is not declared dead.
const STALE_MS = 30_000;

/** Called every second by each Engine. */
export function beat(): void {
  const file = path.join(files.owners(), OWNER);
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    try {
      fs.mkdirSync(files.owners(), { recursive: true });
      fs.writeFileSync(file, '');
    } catch {
      // the next beat tries again
    }
  }
}

/** Remove heartbeats of owners gone for a day; called once at startup. */
export function sweepOwners(): void {
  try {
    for (const name of fs.readdirSync(files.owners())) {
      const file = path.join(files.owners(), name);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 3600_000) fs.rmSync(file, { force: true });
    }
  } catch {
    // nothing to sweep
  }
}

/** Records written before owner tokens existed have only a pid; those fall back to the pid check. */
export function ownerAlive(owner: string | undefined, pid: number | undefined): boolean {
  if (!owner) return processAlive(pid);
  if (owner === OWNER) return true;
  if (!processAlive(Number(owner.split('.')[0]))) return false;
  try {
    return Date.now() - fs.statSync(path.join(files.owners(), owner)).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

/** Whether this process started the job, so only it may run or abort it. */
export function isMine(job: { owner?: string; pid?: number }): boolean {
  return job.owner ? job.owner === OWNER : job.pid === process.pid;
}
