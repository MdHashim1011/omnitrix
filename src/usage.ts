import fs from 'node:fs';
import { ensureHome, files } from './store.js';
import type { Account, AccountHealth, UsageRecord } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function recordUsage(rec: UsageRecord): void {
  ensureHome();
  fs.appendFileSync(files.ledger(), JSON.stringify(rec) + '\n');
}

export function readLedger(sinceMs = 0): UsageRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(files.ledger(), 'utf8');
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

/** Drop records older than 35 days once the file gets big. */
export function compactLedger(maxBytes = 5_000_000): void {
  try {
    if (fs.statSync(files.ledger()).size < maxBytes) return;
  } catch {
    return;
  }
  const keep = readLedger(Date.now() - 35 * DAY);
  fs.writeFileSync(files.ledger(), keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
}

export interface WindowUse {
  name: string;
  used: number;
  limit: number;
  remaining: number;
  unit: 'requests' | 'tokens';
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
  lastUsedAt?: number;
}

/** Start of the current calendar month in local time. */
function monthStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export function summarize(account: Account, records: UsageRecord[], health: AccountHealth | undefined, now = Date.now()): UsageSummary {
  const mine = records.filter((r) => r.accountId === account.id);
  // failed calls that never reached the model do not count against a quota
  const counted = mine.filter((r) => r.ok || r.errorKind === 'rate_limit' || r.errorKind === 'quota');
  const since = (ms: number) => counted.filter((r) => r.ts >= now - ms);
  const tokens = (list: UsageRecord[]) => list.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);

  const day = since(DAY);
  const month = counted.filter((r) => r.ts >= monthStart(now));
  const windows: WindowUse[] = [];
  const add = (name: string, used: number, limit: number | undefined, unit: WindowUse['unit']) => {
    if (limit && limit > 0) windows.push({ name, used, limit, remaining: Math.max(0, limit - used), unit });
  };
  const l = account.limits;
  add('1 minute', since(MIN).length, l.requestsPerMinute, 'requests');
  add('5 hours', since(5 * HOUR).length, l.requestsPer5h, 'requests');
  add('24 hours', day.length, l.requestsPerDay, 'requests');
  add('7 days', since(7 * DAY).length, l.requestsPerWeek, 'requests');
  add('24 hours', tokens(day), l.tokensPerDay, 'tokens');
  add('this month', tokens(month), l.tokensPerMonth, 'tokens');

  let percentUsed: number | undefined;
  for (const w of windows) {
    const p = Math.min(100, Math.round((w.used / w.limit) * 100));
    percentUsed = Math.max(percentUsed ?? 0, p);
  }

  // A fresh number straight from the provider beats our own count.
  const m = health?.measured;
  const fresh = m && now - m.at < 10 * MIN && (!m.resetAt || m.resetAt > now);
  const source: UsageSummary['source'] = fresh ? 'measured' : windows.length ? 'estimated' : 'untracked';

  return {
    accountId: account.id,
    requestsToday: day.length,
    tokensToday: tokens(day),
    tokensMonth: tokens(month),
    costToday: day.reduce((s, r) => s + (r.costUsd ?? 0), 0),
    windows,
    percentUsed,
    source,
    measured: fresh ? m : undefined,
    lastUsedAt: mine.length ? mine[mine.length - 1]!.ts : undefined,
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
