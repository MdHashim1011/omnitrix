import { execFile } from 'node:child_process';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildReport, formatReport } from '../src/report.js';
import { files, writeJson } from '../src/store.js';
import type { Job } from '../src/types.js';
import { tempHome } from './helpers.js';

const NOW = Date.UTC(2026, 10, 23, 12);
let n = 0;
function job(over: Partial<Job> & { type?: Job['task']['type']; seconds?: number; tokens?: number } = {}): Job {
  const start = over.createdAt ?? NOW - 3600_000;
  const { type = 'code', seconds = 10, tokens = 1000, ...rest } = over;
  return {
    id: `jtest${(n++).toString(36).padStart(4, '0')}`,
    task: { title: 't', type, prompt: 'p' },
    status: 'done',
    createdAt: start,
    updatedAt: start + 999_999, // a later rating moves this; the report must not use it
    attempts: [{ accountId: 'codex', model: 'default', startedAt: start, endedAt: start + seconds * 1000, ok: true }],
    accountId: 'codex',
    model: 'default',
    usage: { inputTokens: tokens - 100, outputTokens: 100 },
    ...rest,
  };
}

beforeEach(() => {
  n = 0;
});

describe('the report of past jobs', () => {
  it('groups jobs by account, model and task type, with verdicts, median time and tokens', () => {
    const r = buildReport([
      job({ verdict: 'accepted', seconds: 10 }),
      job({ verdict: 'accepted', seconds: 30 }),
      job({ verdict: 'rejected', seconds: 20 }),
      job({ seconds: 40 }),
      job({ accountId: 'gemini', model: 'flash', type: 'review', verdict: 'accepted', seconds: 5, attempts: [{ accountId: 'gemini', model: 'flash', startedAt: NOW - 3600_000, endedAt: NOW - 3600_000 + 5000, ok: true }] }),
    ], NOW - 30 * 86400_000);
    expect(r.rows).toEqual([
      { account: 'codex', model: 'default', type: 'code', jobs: 4, failed: 0, accepted: 2, rejected: 1, medianSeconds: 25, tokens: 4000, checksPassed: 0, checksFailed: 0 },
      { account: 'gemini', model: 'flash', type: 'review', jobs: 1, failed: 0, accepted: 1, rejected: 0, medianSeconds: 5, tokens: 1000, checksPassed: 0, checksFailed: 0 },
    ]);
    expect(r.totals).toEqual({ jobs: 5, failed: 0, accepted: 3, rejected: 1, tokens: 5000 });
  });

  it('counts failed jobs, leaves out running ones, old ones and checks, and counts check verdicts on the checked job', () => {
    const r = buildReport([
      job({ status: 'failed', accountId: undefined, model: undefined, attempts: [{ accountId: 'codex', model: 'default', startedAt: NOW - 100_000, endedAt: NOW - 90_000, ok: false }], usage: undefined }),
      job({ status: 'running' }),
      job({ createdAt: NOW - 40 * 86400_000 }),
      job({ checkOf: 'jother' }),
      job({ check: { status: 'pass', job_id: 'jc1', by: 'gemini/flash' } as any }),
      job({ check: { status: 'fail', job_id: 'jc2', by: 'gemini/flash' } as any }),
    ], NOW - 30 * 86400_000);
    expect(r.rows).toEqual([{ account: 'codex', model: 'default', type: 'code', jobs: 3, failed: 1, accepted: 0, rejected: 0, medianSeconds: 10, tokens: 2000, checksPassed: 1, checksFailed: 1 }]);
    expect(r.totals.jobs).toBe(3);
  });

  it('prints a table that says how many rated jobs each rate rests on', () => {
    const r = buildReport([job({ verdict: 'accepted' }), job({ verdict: 'accepted' }), job({ verdict: 'rejected' })], NOW - 30 * 86400_000);
    const text = formatReport(r, 30);
    expect(text).toMatch(/^Last 30 days: 3 jobs, 2 accepted, 1 rejected, 0 not rated, 0 failed/);
    expect(text).toMatch(/codex\/default\s+code\s+3\s+67% of 3/);
    expect(text).toMatch(/fewer than 5 rated jobs/);
  });

  it('says so when there is nothing to report', () => {
    expect(formatReport(buildReport([], 0), 30)).toMatch(/No finished jobs in the last 30 days/);
  });
});

describe('omnitrix report', () => {
  it('reads the job files and prints the table, or JSON', async () => {
    const home = tempHome();
    const now = Date.now();
    for (const j of [job({ createdAt: now - 1000, verdict: 'accepted' }), job({ createdAt: now - 2000, verdict: 'rejected' })]) writeJson(path.join(files.jobs(), `${j.id}.json`), j);
    const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const run = (args: string[]) => new Promise<string>((resolve) => execFile(process.execPath, [cli, ...args], { env: { ...process.env, OMNITRIX_HOME: home } }, (_e, out) => resolve(String(out))));
    expect(await run(['report'])).toMatch(/2 jobs, 1 accepted, 1 rejected/);
    const json = JSON.parse(await run(['report', '--json', '--days', '7']));
    expect(json.totals).toMatchObject({ jobs: 2, accepted: 1, rejected: 1 });
  }, 30_000);
});
