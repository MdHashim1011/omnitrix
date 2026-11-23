// What the workers really did, from the job files: per account, model and task type, how many jobs
// finished or failed, how many Claude accepted or rejected, how long they took and how many tokens they used.
import type { Job, TaskType } from './types.js';

export interface ReportRow {
  account: string;
  model: string;
  type: TaskType;
  /** finished or failed jobs */
  jobs: number;
  failed: number;
  accepted: number;
  rejected: number;
  /** median time from the start to the end of the successful run, in seconds; null when none ended */
  medianSeconds: number | null;
  tokens: number;
  /** verdicts of the second model's check on these jobs */
  checksPassed: number;
  checksFailed: number;
}

export interface Report {
  rows: ReportRow[];
  totals: {
    jobs: number; failed: number; accepted: number; rejected: number; tokens: number;
    /** the tokens of jobs that Claude accepted, that it rejected, and of failed jobs; the rest are not rated yet */
    acceptedTokens: number; rejectedTokens: number; failedTokens: number;
  };
}

/** Below this many rated jobs, an acceptance rate says little; the table says so. */
const SMALL = 5;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Finished and failed jobs created since the given time. Checks are counted on the job they checked, not as jobs. */
export function buildReport(jobs: Job[], since: number): Report {
  const groups = new Map<string, { row: ReportRow; times: number[] }>();
  const spent = { acceptedTokens: 0, rejectedTokens: 0, failedTokens: 0 };
  for (const j of jobs) {
    if (j.checkOf || j.createdAt < since || (j.status !== 'done' && j.status !== 'failed')) continue;
    const last = j.attempts[j.attempts.length - 1];
    const account = j.accountId ?? last?.accountId;
    const model = j.model ?? last?.model;
    if (!account || !model) continue;
    const key = `${account}\0${model}\0${j.task.type}`;
    let g = groups.get(key);
    if (!g) {
      g = { row: { account, model, type: j.task.type, jobs: 0, failed: 0, accepted: 0, rejected: 0, medianSeconds: null, tokens: 0, checksPassed: 0, checksFailed: 0 }, times: [] };
      groups.set(key, g);
    }
    const r = g.row;
    r.jobs++;
    if (j.status === 'failed') r.failed++;
    if (j.verdict === 'accepted') r.accepted++;
    if (j.verdict === 'rejected') r.rejected++;
    const used = j.usage ? j.usage.inputTokens + j.usage.outputTokens : 0;
    r.tokens += used;
    if (j.status === 'failed') spent.failedTokens += used;
    else if (j.verdict === 'accepted') spent.acceptedTokens += used;
    else if (j.verdict === 'rejected') spent.rejectedTokens += used;
    if (j.check?.status === 'pass') r.checksPassed++;
    if (j.check?.status === 'fail') r.checksFailed++;
    // the run's own start and end: a job's updatedAt also moves when Claude rates it later
    const ok = [...j.attempts].reverse().find((a) => a.ok && a.endedAt !== undefined);
    if (j.status === 'done' && ok) g.times.push((ok.endedAt! - ok.startedAt) / 1000);
  }
  const rows = [...groups.values()].map(({ row, times }) => ({ ...row, medianSeconds: median(times) }));
  rows.sort((a, b) => b.jobs - a.jobs || a.account.localeCompare(b.account) || a.model.localeCompare(b.model) || a.type.localeCompare(b.type));
  const totals = { jobs: 0, failed: 0, accepted: 0, rejected: 0, tokens: 0, ...spent };
  for (const r of rows) {
    totals.jobs += r.jobs;
    totals.failed += r.failed;
    totals.accepted += r.accepted;
    totals.rejected += r.rejected;
    totals.tokens += r.tokens;
  }
  return { rows, totals };
}

function tokens(n: number): string {
  return n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function time(s: number | null): string {
  if (s === null) return '-';
  return s < 60 ? `${Math.round(s)} s` : `${Math.round(s / 6) / 10} min`;
}

/** The report as a table for the terminal. */
export function formatReport(r: Report, days: number): string {
  const t = r.totals;
  if (!t.jobs) return `No finished jobs in the last ${days} days.`;
  const unrated = t.jobs - t.failed - t.accepted - t.rejected;
  const lines = [`Last ${days} days: ${t.jobs} jobs, ${t.accepted} accepted, ${t.rejected} rejected, ${Math.max(0, unrated)} not rated, ${t.failed} failed; ${tokens(t.tokens)} tokens on the workers' accounts`];
  // where the workers' tokens went: work Claude kept, and work it threw away or that failed
  if (t.tokens) {
    const unratedTokens = t.tokens - t.acceptedTokens - t.rejectedTokens - t.failedTokens;
    lines.push(`Of those tokens, ${tokens(t.acceptedTokens)} went to work Claude accepted, ${tokens(t.rejectedTokens)} to work it rejected, ${tokens(t.failedTokens)} to failed jobs and ${tokens(Math.max(0, unratedTokens))} to work not rated yet.`);
  }
  lines.push('');
  const table = [['model', 'type', 'jobs', 'accepted', 'failed', 'median time', 'tokens', 'check pass/fail']];
  let small = false;
  for (const x of r.rows) {
    const rated = x.accepted + x.rejected;
    if (rated && rated < SMALL) small = true;
    table.push([
      `${x.account}/${x.model}`, x.type, String(x.jobs),
      rated ? `${Math.round((x.accepted / rated) * 100)}% of ${rated}` : 'not rated',
      String(x.failed), time(x.medianSeconds), tokens(x.tokens),
      x.checksPassed || x.checksFailed ? `${x.checksPassed}/${x.checksFailed}` : '-',
    ]);
  }
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  for (const row of table) lines.push(row.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd());
  lines.push('', '"accepted" is the share of the jobs Claude rated that it accepted.');
  if (small) lines.push('A rate from fewer than 5 rated jobs says little; rate more results with rate_result to make it reliable.');
  return lines.join('\n');
}
