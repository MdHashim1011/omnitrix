import { describe, expect, it } from 'vitest';
import { describeWindow } from '../src/mcp.js';
import type { AccountQuota } from '../src/quota.js';
import type { UsageRecord } from '../src/types.js';
import { summarize } from '../src/usage.js';
import { account } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 10, 13, 12, 0, 0);

function requests(n: number, from: number, to: number): UsageRecord[] {
  // spread n requests evenly between `from` and `to` milliseconds ago
  return Array.from({ length: n }, (_, i) => ({
    ts: now - from + ((i + 0.5) / n) * (from - to), accountId: 'a', model: 'm', inputTokens: 100, outputTokens: 0, ok: true, latencyMs: 5,
  }));
}

function plan(usedPercent: number, minutes: number, resetsIn: number): AccountQuota {
  return { at: now, windows: [{ name: '5 hours', minutes, usedPercent, resetsAt: now + resetsIn }] };
}

describe('burn-rate forecast', () => {
  const codex = account({ id: 'a', provider: 'codex', driver: 'cli' });

  it('projects a provider window from its pace since the window began', () => {
    // 2 hours into a 5-hour window with 60% used: 30% an hour, so the last 40% lasts 80 minutes
    const s = summarize(codex, [], undefined, now, plan(60, 300, 3 * HOUR));
    expect(s.windows[0]!.runsOutAt).toBe(now + 80 * MIN);
  });

  it('gives no forecast when the window resets before it would run out', () => {
    // 2 hours in with 30% used: 15% an hour, 70% left lasts 4 h 40 min, but it resets in 3 h
    const s = summarize(codex, [], undefined, now, plan(30, 300, 3 * HOUR));
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
  });

  it('waits until a window has run long enough to judge its pace', () => {
    // 5 minutes in with 10% used would project far too steep a pace
    const s = summarize(codex, [], undefined, now, plan(10, 300, 295 * MIN));
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
  });

  it('needs a full day of a weekly provider window before it judges the pace', () => {
    // seen in real use: one large job used 2% of the week in under 2 hours, and the straight line
    // said the week would run out in three and a half days
    const early = summarize(codex, [], undefined, now, plan(2, 7 * 24 * 60, 7 * DAY - 105 * MIN));
    expect(early.windows[0]!.runsOutAt).toBeUndefined();
    // a day and a half in with 40% used: the last 60% lasts 2 days 6 hours, before the reset
    const later = summarize(codex, [], undefined, now, plan(40, 7 * 24 * 60, 5.5 * DAY));
    expect(later.windows[0]!.runsOutAt).toBe(now + 54 * HOUR);
  });

  it('projects a counted window from the last hour of requests', () => {
    const acc = account({ id: 'a', limits: { requestsPerDay: 100 } });
    // 40 requests earlier today and 50 in the last hour: 10 left at 50 an hour is 12 minutes
    const s = summarize(acc, [...requests(40, 10 * HOUR, 2 * HOUR), ...requests(50, HOUR, 0)], undefined, now);
    const day = s.windows.find((w) => w.name === '24 hours')!;
    expect(day.remaining).toBe(10);
    expect(day.runsOutAt).toBeCloseTo(now + 12 * MIN, -3);
  });

  it('projects tokens from the same last-hour pace', () => {
    const acc = account({ id: 'a', limits: { tokensPerDay: 10_000 } });
    // 9,000 tokens used, 6,000 of them in the last hour: 1,000 left lasts 10 minutes
    const s = summarize(acc, [...requests(30, 5 * HOUR, 2 * HOUR), ...requests(60, HOUR, 0)], undefined, now);
    expect(s.windows[0]!.runsOutAt).toBeCloseTo(now + 10 * MIN, -3);
  });

  it('ignores a pace that would not use up a rolling window within its own length', () => {
    // 3 requests an hour against 1,000 a day would take more than a day, by which time old use drops off
    const acc = account({ id: 'a', limits: { requestsPerDay: 1000 } });
    const s = summarize(acc, requests(3, HOUR, 0), undefined, now);
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
  });

  it('needs at least three requests in the last hour', () => {
    const acc = account({ id: 'a', limits: { requestsPerDay: 10 } });
    const s = summarize(acc, [...requests(7, 5 * HOUR, 2 * HOUR), ...requests(2, HOUR, 0)], undefined, now);
    expect(s.windows[0]!.remaining).toBe(1);
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
  });

  it('gives no forecast for a window that is already used up', () => {
    const acc = account({ id: 'a', limits: { requestsPerDay: 10 } });
    const s = summarize(acc, requests(10, HOUR, 0), undefined, now);
    expect(s.windows[0]!.remaining).toBe(0);
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
    expect(summarize(codex, [], undefined, now, plan(100, 300, 3 * HOUR)).windows[0]!.runsOutAt).toBeUndefined();
  });

  it('never forecasts the one-minute window', () => {
    // 300 requests an hour would use the last slot in seconds, but a one-minute window refills too fast to warn about
    const acc = account({ id: 'a', limits: { requestsPerMinute: 5 } });
    const s = summarize(acc, [...requests(296, HOUR, 61_000), ...requests(4, 50_000, 0)], undefined, now);
    expect(s.windows[0]!.remaining).toBe(1);
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
  });

  it('says when a window runs out in the pool text Claude reads', () => {
    const s = summarize(codex, [], undefined, now, plan(60, 300, 3 * HOUR));
    const text = describeWindow(s.windows[0]!, now);
    expect(text).toContain('40% left');
    expect(text).toContain('runs out in about 1 h 20 min at this pace');
  });
});

describe('forecast in the account summary', () => {
  it('measures the forecast from the real clock, not from a list position', async () => {
    const { describeAccount } = await import('../src/mcp.js');
    const t = Date.now();
    const usage = summarize(account({ id: 'a' }), [], undefined, t, { at: t, windows: [{ name: '5 hours', minutes: 300, usedPercent: 60, resetsAt: t + 3 * HOUR }] });
    const view = { id: 'a', label: 'a', owner: 'me', provider: 'codex', driver: 'cli', enabled: true, state: 'ready', running: 0, models: ['default'], usage, local: false, pausedModels: [], trainsOnData: false };
    expect(describeAccount(view as Parameters<typeof describeAccount>[0])).toMatch(/runs out in about 1 h (19|20) min at this pace/);
  });
});

describe('forecast edge cases', () => {
  const codex = account({ id: 'a', provider: 'codex', driver: 'cli' });

  it('gives no forecast for a reading saved before window lengths were recorded', () => {
    const s = summarize(codex, [], undefined, now, { at: now, windows: [{ name: '5 hours', usedPercent: 60, resetsAt: now + 3 * HOUR }] });
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
    expect(describeWindow(s.windows[0]!, now)).not.toContain('runs out');
  });

  it('counts the pace from when an older reading was taken', () => {
    // read 30 minutes ago: 2 hours into the window with 60% used, so it runs out 80 minutes after the reading
    const at = now - 30 * MIN;
    const s = summarize(codex, [], undefined, now, { at, windows: [{ name: '5 hours', minutes: 300, usedPercent: 60, resetsAt: at + 3 * HOUR }] });
    expect(s.windows[0]!.runsOutAt).toBe(at + 80 * MIN);
  });

  it('drops a forecast whose time has already passed', () => {
    const at = now - 2 * HOUR;
    const s = summarize(codex, [], undefined, now, { at, windows: [{ name: '5 hours', minutes: 300, usedPercent: 60, resetsAt: at + 3 * HOUR }] });
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
  });

  it('gives no forecast when the reset time is later than the window could have opened', () => {
    // a clock ahead of the provider's can make the window look as if it has not opened yet
    const s = summarize(codex, [], undefined, now, plan(60, 300, 5 * HOUR + 30 * MIN));
    expect(s.windows[0]!.runsOutAt).toBeUndefined();
  });

  it('survives hand-edited readings', () => {
    for (const w of [{ minutes: -5, usedPercent: 60 }, { minutes: Number('x'), usedPercent: 60 }, { minutes: 300, usedPercent: 150 }]) {
      const s = summarize(codex, [], undefined, now, { at: now, windows: [{ name: '5 hours', ...w, resetsAt: now + 3 * HOUR }] });
      expect(s.windows[0]!.runsOutAt).toBeUndefined();
    }
  });

  it('gives no forecast for weekly or monthly limits, where one busy hour says little', () => {
    const acc = account({ id: 'a', limits: { requestsPerWeek: 100, tokensPerMonth: 10_000 } });
    // 95 requests (9,500 tokens) used, 30 of them in the last hour: a day window would run out in minutes
    const s = summarize(acc, [...requests(65, 3 * DAY, 2 * HOUR), ...requests(30, HOUR, 0)], undefined, now);
    expect(s.windows.map((w) => w.runsOutAt)).toEqual([undefined, undefined]);
  });
});

describe('requests in the last 24 hours (field report)', () => {
  it('counts failed requests too, and says so, so the line matches the usage log', async () => {
    // seen in real use: "today: 1 req" while the usage log held three failed requests as well
    const failed = (n: number): UsageRecord[] => Array.from({ length: n }, (_, i) => ({ ts: now - (i + 1) * MIN, accountId: 'a', model: 'm', inputTokens: 0, outputTokens: 0, ok: false, errorKind: 'timeout' as const, latencyMs: 300_000 }));
    const s = summarize(account({ id: 'a', local: true }), [...requests(1, 30 * MIN, 0), ...failed(3)], undefined, now);
    expect(s.requestsToday).toBe(1);
    expect(s.failedToday).toBe(3);
    const { describeAccount } = await import('../src/mcp.js');
    const text = describeAccount({ id: 'a', label: 'a', state: 'ready', provider: 'ollama', owner: 'me', models: ['m'], usage: s } as any);
    expect(text).toMatch(/last 24 h: 1 answered, 3 failed/);
  });
});
