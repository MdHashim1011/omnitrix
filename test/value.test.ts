import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { files, writeJson } from '../src/store.js';
import type { UsageRecord } from '../src/types.js';
import { recordUsage } from '../src/usage.js';
import { delegated } from '../src/value.js';
import { account, tempHome, writeConfig } from './helpers.js';

const DAY = 24 * 3600_000;
const now = Date.now();
const rec = (over: Partial<UsageRecord>): UsageRecord => ({ ts: now - 3600_000, accountId: 'a', model: 'm', inputTokens: 1000, outputTokens: 500, ok: true, latencyMs: 1000, ...over });

describe('work done by other accounts', () => {
  it('counts the jobs and tokens that other accounts handled, and how many Claude accepted', () => {
    const records = [
      rec({ jobId: 'j1' }),
      rec({ jobId: 'j1', accountId: 'b' }),
      rec({ jobId: 'j2' }),
      // a failed request did no work for Claude
      rec({ jobId: 'j3', ok: false, inputTokens: 0, outputTokens: 0 }),
      // `omnitrix test` is not delegated work
      rec({}),
      // too old for the period
      rec({ jobId: 'j4', ts: now - 9 * DAY }),
    ];
    const verdicts = new Map([['j1', 'accepted' as const], ['j2', 'rejected' as const]]);
    expect(delegated(records, verdicts, now - 7 * DAY)).toEqual({ jobs: 2, accepted: 1, rejected: 1, tokens: 4500 });
  });

  it('reads the usage log and the job records of this computer', () => {
    tempHome();
    writeConfig([account({ id: 'a' })]);
    recordUsage(rec({ jobId: 'jvalue1' }));
    writeJson(path.join(files.jobs(), 'jvalue1.json'), { id: 'jvalue1', status: 'done', verdict: 'accepted', createdAt: now, updatedAt: now, attempts: [], task: { title: 't', type: 'review', prompt: 'p' } });
    expect(new Engine().delegated(7)).toEqual({ days: 7, jobs: 1, accepted: 1, rejected: 0, tokens: 1500 });
  });
});

describe('the line Claude reads in pool_status', () => {
  it('says how much work other accounts did, in plain words', async () => {
    const { describeDelegated } = await import('../src/value.js');
    expect(describeDelegated({ days: 7, jobs: 29, accepted: 13, rejected: 9, tokens: 1_543_008 })).toBe('last 7 days: other accounts answered 29 jobs (13 accepted, 9 rejected by Claude) and processed 1.5M tokens that Claude did not have to');
    expect(describeDelegated({ days: 7, jobs: 1, accepted: 0, rejected: 0, tokens: 900 })).toBe('last 7 days: other accounts answered 1 job and processed 900 tokens that Claude did not have to');
  });
});
