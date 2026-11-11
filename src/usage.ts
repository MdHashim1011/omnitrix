// Works out what each account has used per time window, from an append-only log of every request.
import fs from 'node:fs';
import path from 'node:path';
import type { AccountQuota } from './quota.js';
import { ensureHome, files, processAlive } from './store.js';
import type { Account, AccountHealth, UsageRecord } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function recordUsage(rec: UsageRecord): void {
  ensureHome();
  fs.appendFileSync(files.ledger(), JSON.stringify(rec) + '\n');
}

export function readLedger(sinceMs = 0): UsageRecord[] {
  // While another process compacts, its old lines sit in a .compacting file. Counting them too means a
  // reader never sees usage drop to zero; the overlap just before that file is deleted counts twice,
  // which only errs towards caution.
  let raw = '';
  const live = files.ledger();
  try {
    const base = path.basename(live);
    const parts = fs.readdirSync(path.dirname(live)).filter((n) => n === base || n.startsWith(`${base}.compacting.`));
    for (const n of parts) {
      try {
        raw += fs.readFileSync(path.join(path.dirname(live), n), 'utf8') + '\n';
      } catch {
        // renamed or deleted between the listing and the read
      }
    }
  } catch {
    return [];
  }
  const out: UsageRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as UsageRecord;
      if (rec.ts >= sinceMs) out.push(rec);
    } catch {
      // a half-written line from a crash; skip it
    }
  }
  return out;
}

/**
 * Keeps the ledger in memory and reads only the lines appended since the last call. The ledger only
 * grows, except while it is compacted (it is renamed aside and rebuilt), so a shorter file or a
 * .compacting file means everything is read again.
 */
export class LedgerTail {
  private offset = 0;
  private records: UsageRecord[] = [];
  private prunedAt = 0;

  read(sinceMs: number): UsageRecord[] {
    const live = files.ledger();
    try {
      const base = path.basename(live);
      if (fs.readdirSync(path.dirname(live)).some((n) => n.startsWith(`${base}.compacting.`))) {
        this.offset = 0;
        this.records = [];
        return readLedger(sinceMs);
      }
    } catch {
      return [];
    }
    let size = 0;
    try {
      size = fs.statSync(live).size;
    } catch {
      // no ledger yet
    }
    if (size < this.offset) {
      this.offset = 0;
      this.records = [];
    }
    if (size > this.offset) {
      const buf = Buffer.alloc(size - this.offset);
      const fd = fs.openSync(live, 'r');
      try {
        fs.readSync(fd, buf, 0, buf.length, this.offset);
      } finally {
        fs.closeSync(fd);
      }
      // stop at the last complete line; a line still being written is picked up next time
      const end = buf.lastIndexOf(10);
      if (end >= 0) {
        for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
          if (!line) continue;
          try {
            this.records.push(JSON.parse(line) as UsageRecord);
          } catch {
            // a line left half-written by a crash
          }
        }
        this.offset += end + 1;
      }
    }
    // records only age out of the window, so trimming once a minute keeps memory bounded
    if (Date.now() - this.prunedAt > 60_000) {
      this.records = this.records.filter((r) => r.ts >= sinceMs);
      this.prunedAt = Date.now();
    }
    return this.records.filter((r) => r.ts >= sinceMs);
  }
}

/**
 * Drop records older than 35 days once the file gets big.
 * Other processes keep appending while this runs. So the ledger is first renamed to a file only this
 * process owns: their new lines start a fresh ledger, and the kept lines are appended to it rather than
 * written over it. Line order changes, which nothing depends on.
 */
export function compactLedger(maxBytes = 5_000_000): void {
  const live = files.ledger();
  const mine = `${live}.compacting.${process.pid}`;
  try {
    const dir = path.dirname(live);
    const base = path.basename(live);
    // A process that crashed mid-compaction left its file behind; take it over by renaming it. A file
    // already named for our own pid can only come from an earlier process that had the same pid.
    const stranded = fs.readdirSync(dir).find((n) => {
      const m = n.startsWith(`${base}.compacting.`) && /\.(\d+)$/.exec(n);
      return m && (Number(m[1]) === process.pid || !processAlive(Number(m[1])));
    });
    if (stranded && path.join(dir, stranded) !== mine) fs.renameSync(path.join(dir, stranded), mine);
    else if (stranded) {
      // already ours to finish
    } else if (fs.statSync(live).size >= maxBytes) fs.renameSync(live, mine);
    else return;
  } catch {
    return;
  }
  const cutoff = Date.now() - 35 * DAY;
  const keep = fs.readFileSync(mine, 'utf8').split('\n').filter((line) => {
    try {
      return line && (JSON.parse(line) as UsageRecord).ts >= cutoff;
    } catch {
      return false;
    }
  });
  // The leading newline ends any half-written line a crashed writer left, so it cannot swallow ours.
  if (keep.length) fs.appendFileSync(live, '\n' + keep.join('\n') + '\n');
  fs.rmSync(mine, { force: true });
}

export interface WindowUse {
  name: string;
  used: number;
  limit: number;
  remaining: number;
  unit: 'requests' | 'tokens' | 'percent';
  resetsAt?: number;
}

export interface UsageSummary {
  accountId: string;
  requestsToday: number;
  tokensToday: number;
  tokensMonth: number;
  costToday: number;
  windows: WindowUse[];
  /** highest percent used across all limits, 0-100; undefined when no limits are known */
  percentUsed?: number;
  /** where the numbers come from */
  source: 'measured' | 'estimated' | 'untracked';
  measured?: AccountHealth['measured'];
  /** subscription plan, when the provider reports one */
  plan?: string;
}

/** Start of the current calendar month in local time. */
function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function summarize(account: Account, records: UsageRecord[], health: AccountHealth | undefined, now = Date.now(), quota?: AccountQuota): UsageSummary {
  // One pass fills every window; this runs for every account on each routing pass and status call.
  let minute = 0;
  let fiveHours = 0;
  let week = 0;
  let day = 0;
  let dayTokens = 0;
  let dayCost = 0;
  let monthTokens = 0;
  const monthFrom = monthStart(now);
  for (const r of records) {
    if (r.accountId !== account.id) continue;
    // failed calls that never reached the model do not count against a quota
    if (!(r.ok || r.errorKind === 'rate_limit' || r.errorKind === 'quota')) continue;
    const t = r.inputTokens + r.outputTokens;
    if (r.ts >= now - MIN) minute++;
    if (r.ts >= now - 5 * HOUR) fiveHours++;
    if (r.ts >= now - 7 * DAY) week++;
    if (r.ts >= now - DAY) {
      day++;
      dayTokens += t;
      dayCost += r.costUsd ?? 0;
    }
    if (r.ts >= monthFrom) monthTokens += t;
  }
  const windows: WindowUse[] = [];
  const add = (name: string, used: number, limit: number | undefined, unit: WindowUse['unit']) => {
    if (limit && limit > 0) windows.push({ name, used, limit, remaining: Math.max(0, limit - used), unit });
  };
  const l = account.limits;
  add('1 minute', minute, l.requestsPerMinute, 'requests');
  add('5 hours', fiveHours, l.requestsPer5h, 'requests');
  add('24 hours', day, l.requestsPerDay, 'requests');
  add('7 days', week, l.requestsPerWeek, 'requests');
  add('24 hours', dayTokens, l.tokensPerDay, 'tokens');
  add('this month', monthTokens, l.tokensPerMonth, 'tokens');

  // Use only climbs inside a window, so an old reading stays a safe lower bound until the window resets.
  // Without a reset time there is no telling when it stopped being true.
  const live = quota?.windows.filter((w) => (w.resetsAt ? w.resetsAt > now : now - quota.at < 10 * MIN)) ?? [];
  for (const w of live) {
    windows.push({ name: w.name, used: w.usedPercent, limit: 100, remaining: 100 - w.usedPercent, unit: 'percent', resetsAt: w.resetsAt });
  }

  let percentUsed: number | undefined;
  for (const w of windows) {
    // Rounding up would mark an account with 0.5% left as exhausted and stop routing to it.
    const p = Math.min(100, w.unit === 'percent' ? Math.floor(w.used) : Math.round((w.used / w.limit) * 100));
    percentUsed = Math.max(percentUsed ?? 0, p);
  }

  // A fresh number straight from the provider beats our own count.
  const m = health?.measured;
  const fresh = m && now - m.at < 10 * MIN && (!m.resetAt || m.resetAt > now);
  const source: UsageSummary['source'] = fresh || live.length ? 'measured' : windows.length ? 'estimated' : 'untracked';

  return {
    accountId: account.id,
    requestsToday: day,
    tokensToday: dayTokens,
    tokensMonth: monthTokens,
    costToday: dayCost,
    windows,
    percentUsed,
    source,
    measured: fresh ? m : undefined,
    plan: quota?.plan,
  };
}

/** 0 = nothing left, 1 = all left. Used by the router to spread load. */
export function headroom(summary: UsageSummary): number {
  const m = summary.measured;
  if (m?.remainingRequests !== undefined && m.remainingRequests <= 0) return 0;
  if (summary.percentUsed === undefined) return 0.8; // unknown: assume fine, but below a tracked fresh account
  return Math.max(0, 1 - summary.percentUsed / 100);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
