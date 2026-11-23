import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { describeLead, leadOut, loadLeadQuota, readLeadInput, saveLeadQuota } from '../src/lead.js';
import { renderStatusLine } from '../src/statusline.js';
import { files } from '../src/store.js';
import { tempHome } from './helpers.js';

const NOW = Date.UTC(2026, 10, 23, 9, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);
const input = (five: number, week: number, fiveReset = NOW + 3600_000, weekReset = NOW + 4 * 86400_000) =>
  JSON.stringify({ rate_limits: { five_hour: { used_percentage: five, resets_at: sec(fiveReset) }, seven_day: { used_percentage: week, resets_at: sec(weekReset) } } });

beforeEach(() => {
  tempHome();
});

describe("reading Claude's own usage from the status line input", () => {
  it('reads both windows, with reset times in seconds or as text', () => {
    expect(readLeadInput(JSON.parse(input(62.4, 40)))).toEqual([
      { name: '5 hours', usedPercent: 62.4, resetsAt: sec(NOW + 3600_000) * 1000 },
      { name: '7 days', usedPercent: 40, resetsAt: sec(NOW + 4 * 86400_000) * 1000 },
    ]);
    const iso = new Date(NOW + 1000).toISOString();
    expect(readLeadInput({ rate_limits: { five_hour: { used_percentage: 5, resets_at: iso } } })).toEqual([{ name: '5 hours', usedPercent: 5, resetsAt: NOW + 1000 }]);
  });

  it('ignores missing, broken or impossible values', () => {
    expect(readLeadInput(undefined)).toEqual([]);
    expect(readLeadInput({ rate_limits: { five_hour: { used_percentage: 'a lot' } } })).toEqual([]);
    expect(readLeadInput({ rate_limits: { five_hour: { used_percentage: NaN }, seven_day: { used_percentage: 150 } } })).toEqual([
      { name: '7 days', usedPercent: 100, resetsAt: null },
    ]);
    expect(readLeadInput({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 'soon' } } })).toEqual([{ name: '5 hours', usedPercent: 10, resetsAt: null }]);
  });
});

describe('saving and loading the lead quota', () => {
  it('saves what the status line saw and loads it back', () => {
    saveLeadQuota(readLeadInput(JSON.parse(input(62, 40))), NOW);
    const q = loadLeadQuota(NOW + 60_000)!;
    expect(q.seenAt).toBe(NOW);
    expect(q.stale).toBe(false);
    expect(q.windows.map((w) => w.usedPercent)).toEqual([62, 40]);
  });

  it('does not rewrite the file for an unchanged reading within a minute', () => {
    const w = readLeadInput(JSON.parse(input(62, 40)));
    saveLeadQuota(w, NOW);
    saveLeadQuota(w, NOW + 30_000);
    expect(loadLeadQuota(NOW + 30_000)!.seenAt).toBe(NOW);
    saveLeadQuota(w, NOW + 61_000);
    expect(loadLeadQuota(NOW + 61_000)!.seenAt).toBe(NOW + 61_000);
    saveLeadQuota(readLeadInput(JSON.parse(input(63, 40))), NOW + 62_000);
    expect(loadLeadQuota(NOW + 62_000)!.windows[0]!.usedPercent).toBe(63);
  });

  it('saves nothing when Claude Code sent no usage', () => {
    saveLeadQuota([], NOW);
    expect(fs.existsSync(files.lead())).toBe(false);
    expect(loadLeadQuota(NOW)).toBeUndefined();
  });

  it('marks an old reading stale and drops a window that has reset since', () => {
    saveLeadQuota(readLeadInput(JSON.parse(input(90, 40, NOW + 600_000))), NOW);
    const later = loadLeadQuota(NOW + 20 * 60_000)!;
    expect(later.stale).toBe(true);
    expect(later.windows.map((w) => w.name)).toEqual(['7 days']);
  });

  it('applies the same checks to a hand-edited file', () => {
    fs.mkdirSync(path.dirname(files.lead()), { recursive: true });
    fs.writeFileSync(files.lead(), JSON.stringify({ seenAt: NOW, windows: [{ name: '5 hours', usedPercent: 500, resetsAt: sec(NOW + 3600_000) }] }));
    expect(loadLeadQuota(NOW)!.windows).toEqual([{ name: '5 hours', usedPercent: 100, resetsAt: sec(NOW + 3600_000) * 1000 }]);
    fs.writeFileSync(files.lead(), JSON.stringify({ seenAt: NOW + 3600_000, windows: [{ name: '7 days', usedPercent: 90, resetsAt: null }] }));
    const future = loadLeadQuota(NOW)!;
    expect(future.stale).toBe(true);
    expect(describeLead(future, NOW)).toMatch(/in the future.*was running low when last seen/);
  });

  it('reads a reset time sent as a string of digits', () => {
    expect(readLeadInput({ rate_limits: { five_hour: { used_percentage: 1, resets_at: String(sec(NOW)) } } })[0]!.resetsAt).toBe(sec(NOW) * 1000);
  });

  it('survives a damaged file', () => {
    fs.mkdirSync(path.dirname(files.lead()), { recursive: true });
    fs.writeFileSync(files.lead(), '{"windows": "no"');
    expect(loadLeadQuota(NOW)).toBeUndefined();
    fs.writeFileSync(files.lead(), JSON.stringify({ seenAt: NOW, windows: [{ name: '5 hours', usedPercent: 'x' }, { name: 'other', usedPercent: 5 }] }));
    expect(loadLeadQuota(NOW)).toBeUndefined();
  });
});

describe('the status line saves the lead quota', () => {
  it('writes the file when Claude Code passes rate limits', () => {
    renderStatusLine(input(12, 3), NOW);
    expect(loadLeadQuota(NOW)!.windows.map((w) => w.usedPercent)).toEqual([12, 3]);
  });
});

describe('describing the lead quota for Claude', () => {
  it('says how much is used and when it resets', () => {
    saveLeadQuota(readLeadInput(JSON.parse(input(40, 20))), NOW);
    const text = describeLead(loadLeadQuota(NOW), NOW);
    expect(text).toMatch(/^Claude \(you, the lead\): 5 hours 40% used \(resets /);
    expect(text).toMatch(/7 days 20% used/);
    expect(text).not.toMatch(/delegate/);
  });

  it('asks Claude to delegate more once 70% of the 5-hour window is used', () => {
    saveLeadQuota(readLeadInput(JSON.parse(input(70, 20))), NOW);
    expect(describeLead(loadLeadQuota(NOW), NOW)).toMatch(/delegate more/);
    saveLeadQuota(readLeadInput(JSON.parse(input(20, 85))), NOW + 120_000);
    expect(describeLead(loadLeadQuota(NOW + 120_000), NOW + 120_000)).toMatch(/delegate more/);
  });

  it('says when the reading is old, and how to get one when there is none', () => {
    saveLeadQuota(readLeadInput(JSON.parse(input(40, 20, NOW + 86400_000))), NOW);
    expect(describeLead(loadLeadQuota(NOW + 30 * 60_000), NOW + 30 * 60_000)).toMatch(/seen 30 min ago/);
    saveLeadQuota(readLeadInput(JSON.parse(input(80, 20, NOW + 86400_000))), NOW + 31 * 60_000);
    expect(describeLead(loadLeadQuota(NOW + 60 * 60_000), NOW + 60 * 60_000)).toMatch(/was running low when last seen/);
    expect(describeLead(undefined, NOW)).toMatch(/usage not reported yet/);
  });

  it('gives structured data that matches the schema', () => {
    saveLeadQuota(readLeadInput(JSON.parse(input(40, 20))), NOW);
    const out = leadOut(loadLeadQuota(NOW));
    expect(out).toEqual({ windows: [{ name: '5 hours', used_percent: 40, resets_at: sec(NOW + 3600_000) * 1000 }, { name: '7 days', used_percent: 20, resets_at: sec(NOW + 4 * 86400_000) * 1000 }], seen_at: NOW, stale: false });
    expect(leadOut(undefined)).toBeNull();
  });
});
