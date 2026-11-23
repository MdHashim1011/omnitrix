// Claude Code passes Claude's own plan usage to the status line command. The status line saves it here, so
// that pool_status can tell Claude how much of its own limit is left and when to hand more work to others.
import fs from 'node:fs';
import path from 'node:path';
import { files, readJson } from './store.js';

export interface LeadWindow {
  name: '5 hours' | '7 days';
  usedPercent: number;
  /** milliseconds since 1970, or null when Claude Code did not say */
  resetsAt: number | null;
}

export interface LeadQuota {
  windows: LeadWindow[];
  /** when the status line last saw these numbers */
  seenAt: number;
  /** true when that was long ago, for example because no Claude Code session is open */
  stale: boolean;
}

/** A reading older than this is reported as old: the status line runs only while a session is open. */
const STALE_MS = 15 * 60_000;
/** The status line runs every few seconds; an unchanged reading is saved again at most this often. */
const RESAVE_MS = 60_000;
/** Used from this share of a window, Claude is asked to delegate more. */
const HIGH = 70;

const NAMES = [['five_hour', '5 hours'], ['seven_day', '7 days']] as const;

function time(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return time(Number(v));
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** The windows in the JSON that Claude Code gives the status line; empty when it holds none. */
export function readLeadInput(json: unknown): LeadWindow[] {
  const limits = (json as { rate_limits?: Record<string, { used_percentage?: unknown; resets_at?: unknown }> } | undefined)?.rate_limits;
  if (!limits || typeof limits !== 'object') return [];
  const out: LeadWindow[] = [];
  for (const [key, name] of NAMES) {
    const used = limits[key]?.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    out.push({ name, usedPercent: Math.min(100, Math.max(0, used)), resetsAt: time(limits[key]?.resets_at) });
  }
  return out;
}

interface Saved {
  seenAt: number;
  windows: LeadWindow[];
}

function load(): Saved | undefined {
  const s = readJson<Partial<Saved> | undefined>(files.lead(), undefined);
  if (!s || typeof s.seenAt !== 'number' || !Array.isArray(s.windows)) return undefined;
  // the file can be edited by hand, so it gets the same checks as the status line input
  const windows: LeadWindow[] = [];
  for (const w of s.windows as Partial<LeadWindow>[]) {
    if (!w || (w.name !== '5 hours' && w.name !== '7 days') || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
    windows.push({ name: w.name, usedPercent: Math.min(100, Math.max(0, w.usedPercent)), resetsAt: time(w.resetsAt) });
  }
  return windows.length ? { seenAt: s.seenAt, windows } : undefined;
}

/** Saves a reading. Skipped when nothing was read, or when the same reading was saved less than a minute ago. */
export function saveLeadQuota(windows: LeadWindow[], now = Date.now()): void {
  if (!windows.length) return;
  const old = load();
  if (old && now - old.seenAt < RESAVE_MS && JSON.stringify(old.windows) === JSON.stringify(windows)) return;
  // One quick try: the status line must stay fast, and the next run saves again if this one is refused.
  const file = files.lead();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${now}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ seenAt: now, windows } satisfies Saved) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

/** The last reading, without windows that have reset since; undefined when there is none. */
export function loadLeadQuota(now = Date.now()): LeadQuota | undefined {
  if (!fs.existsSync(files.lead())) return undefined;
  const s = load();
  if (!s) return undefined;
  const windows = s.windows.filter((w) => w.resetsAt === null || w.resetsAt > now);
  if (!windows.length) return undefined;
  // a time in the future can only come from a changed clock or a hand edit, so it is not trusted as fresh
  return { windows, seenAt: s.seenAt, stale: now - s.seenAt > STALE_MS || s.seenAt > now + RESAVE_MS };
}

function clock(t: number): string {
  return new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** One line for pool_status. */
export function describeLead(q: LeadQuota | undefined, now = Date.now()): string {
  if (!q) return 'Claude (you, the lead): usage not reported yet; the omnitrix status line reports it while a Claude Code session on a Pro or Max plan is open';
  const parts = q.windows.map((w) => `${w.name} ${Math.round(w.usedPercent)}% used${w.resetsAt ? ` (resets ${clock(w.resetsAt)})` : ''}`);
  let line = `Claude (you, the lead): ${parts.join(', ')}`;
  if (q.stale) line += q.seenAt > now ? '; the time of this reading is in the future, so it may be wrong' : `; seen ${Math.round((now - q.seenAt) / 60_000)} min ago`;
  if (q.windows.some((w) => w.usedPercent >= HIGH)) {
    line += q.stale ? '; your own limit was running low when last seen, so delegate more unless you know it has reset' : '; your own limit is running low, so delegate more and keep your own reading short';
  }
  return line;
}

/** The structured form for pool_status. */
export function leadOut(q: LeadQuota | undefined) {
  if (!q) return null;
  return { windows: q.windows.map((w) => ({ name: w.name, used_percent: w.usedPercent, resets_at: w.resetsAt })), seen_at: q.seenAt, stale: q.stale };
}
