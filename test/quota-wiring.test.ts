import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { describeWindow } from '../src/mcp.js';
import { loadQuotas, refreshQuotas } from '../src/quota.js';
import { files, writeJson } from '../src/store.js';
import { headroom, summarize } from '../src/usage.js';
import { account, tempHome, writeConfig } from './helpers.js';

beforeEach(() => tempHome());

describe('quota summaries', () => {
  it('exposes measured percent windows, plan and the most constrained headroom', () => {
    const now = Date.now();
    const windows = [
      { name: '5 hours', usedPercent: 3, resetsAt: now + 3600_000 },
      { name: '7 days', usedPercent: 81, resetsAt: now + 86400_000 },
    ];
    const s = summarize(account({ id: 'summary' }), [], undefined, now, { at: now, plan: 'plus', windows });
    expect(s.windows).toEqual(windows.map((w) => ({ name: w.name, unit: 'percent', limit: 100, used: w.usedPercent, remaining: 100 - w.usedPercent, resetsAt: w.resetsAt })));
    expect(s.source).toBe('measured');
    expect(s.plan).toBe('plus');
    expect(s.percentUsed).toBe(81);
    expect(headroom(s)).toBeCloseTo(0.19);
  });

  it('skips reset windows and falls back to untracked when none remain', () => {
    const now = Date.now();
    const acc = account({ id: 'reset' });
    const expired = { name: '5 hours', usedPercent: 100, resetsAt: now - 1 };
    const live = { name: '7 days', usedPercent: 20, resetsAt: now + 86400_000 };
    const mixed = summarize(acc, [], undefined, now, { at: now, windows: [expired, live] });
    expect(mixed.windows.map((w) => w.name)).toEqual(['7 days']);
    expect(mixed.percentUsed).toBe(20);
    const reset = summarize(acc, [], undefined, now, { at: now, windows: [expired] });
    expect(reset.windows).toEqual([]);
    expect(reset.source).toBe('untracked');
    expect(reset.percentUsed).toBeUndefined();
  });

  it('uses windows without reset times only for readings under ten minutes old', () => {
    const now = Date.now();
    const acc = account({ id: 'freshness' });
    const windows = [{ name: '5 hours', usedPercent: 3 }];
    const fresh = summarize(acc, [], undefined, now, { at: now - 9 * 60_000, windows });
    expect(fresh.windows).toHaveLength(1);
    expect(fresh.percentUsed).toBe(3);
    expect(fresh.source).toBe('measured');
    const stale = summarize(acc, [], undefined, now, { at: now - 11 * 60_000, windows });
    expect(stale.windows).toEqual([]);
    expect(stale.source).toBe('untracked');
    expect(stale.percentUsed).toBeUndefined();
  });

  it('does not round a nearly full window up to exhausted', () => {
    const now = Date.now();
    const s = summarize(account({ id: 'almost-full' }), [], undefined, now, {
      at: now,
      windows: [{ name: '5 hours', usedPercent: 99.5, resetsAt: now + 3600_000 }],
    });
    expect(s.percentUsed).toBe(99);
    expect(headroom(s)).toBeGreaterThan(0);
  });

  it('keeps hours-old readings until their future reset', () => {
    const now = Date.now();
    const s = summarize(account({ id: 'old-live' }), [], undefined, now, {
      at: now - 3 * 3600_000,
      windows: [{ name: '5 hours', usedPercent: 97, resetsAt: now + 3600_000 }],
    });
    expect(s.windows).toHaveLength(1);
    expect(s.source).toBe('measured');
    expect(s.percentUsed).toBe(97);
  });
});

it('marks a persisted full Codex quota exhausted and rejects it in previews', () => {
  const acc = account({ id: 'engine-quota', provider: 'codex', driver: 'cli' });
  writeConfig([acc]);
  writeJson(files.quota(), { [acc.id]: { at: Date.now(), windows: [{ name: '5 hours', usedPercent: 100, resetsAt: Date.now() + 3600_000 }] } });
  const engine = new Engine();
  expect(engine.pool()).toMatchObject([{ id: acc.id, state: 'exhausted' }]);
  const preview = engine.preview({ title: 'write', type: 'writing', prompt: 'hello' });
  expect(preview.candidates).toEqual([]);
  expect(preview.rejected).toContainEqual(expect.objectContaining({ accountId: acc.id, reason: 'no quota left in the current window' }));
});

describe('quota window descriptions', () => {
  it('formats percent headroom with a reset suffix only when present', () => {
    const window = { name: '5 hours', unit: 'percent' as const, used: 3, limit: 100, remaining: 97 };
    expect(describeWindow(window)).toBe('5 hours: 97% left');
    const resetsAt = Date.now() + 3600_000;
    const reset = new Date(resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    expect(describeWindow({ ...window, resetsAt })).toBe(`5 hours: 97% left (resets ${reset})`);
  });

  it('preserves request window formatting', () => {
    expect(describeWindow({ name: '1 minute', unit: 'requests', used: 7, limit: 10, remaining: 3 })).toBe('1 minute: 3/10 requests left');
  });
});

describe('refreshQuotas', () => {
  let oldPath: string | undefined;

  beforeEach(() => { oldPath = process.env.PATH; });
  afterEach(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  });

  function installFakeCodex(mode: 'answer' | 'exit' | 'slow' = 'answer') {
    const bin = path.join(process.env.OMNITRIX_HOME!, 'bin');
    fs.mkdirSync(bin);
    const counter = path.join(bin, 'starts');
    const seen = path.join(bin, 'seen.json');
    fs.writeFileSync(counter, '');
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const script = path.join(bin, 'fake-codex.js');
    fs.writeFileSync(script, `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(counter)}, 'start\\n');
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ key: process.env.OPENAI_API_KEY ?? null, home: process.env.CODEX_HOME, cwd: process.cwd() }));
if (${JSON.stringify(mode)} === 'exit') process.exit(0);
if (${JSON.stringify(mode)} === 'slow') { setTimeout(() => process.exit(0), 1500); process.stdin.resume(); return; }
const lines = require('readline').createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === 1 && message.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
  }
  if (message.id === 2 && message.method === 'account/rateLimits/read') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: ${resetsAt} }, planType: 'plus' } } }));
  }
});`);
    if (process.platform === 'win32') {
      // Match npm's shim layout so resolveCommand can launch the script directly.
      fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\n"%_prog%"  "%dp0%\\fake-codex.js" %*\r\n`);
    } else {
      fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
    }
    process.env.PATH = bin + path.delimiter + (oldPath ?? '');
    return { counter, seen, resetsAt: resetsAt * 1000 };
  }

  it('hides exported API keys from Codex and runs it outside the project folder', async () => {
    const fake = installFakeCodex();
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    try {
      const acc = account({ id: 'refresh-env', provider: 'codex', profileDir: process.env.OMNITRIX_HOME });
      await refreshQuotas([acc], 60_000);
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
    }
    const seen = JSON.parse(fs.readFileSync(fake.seen, 'utf8'));
    expect(seen.key).toBeNull();
    expect(seen.home).toBe(process.env.OMNITRIX_HOME);
    expect(path.resolve(seen.cwd)).not.toBe(path.resolve(process.cwd()));
  });

  it('returns after waitMs while a slow read carries on', async () => {
    installFakeCodex('slow');
    const acc = account({ id: 'refresh-slow', provider: 'codex', profileDir: process.env.OMNITRIX_HOME });
    const started = Date.now();
    await refreshQuotas([acc], 60_000, 200);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('persists a reading while preserving other accounts', async () => {
    const fake = installFakeCodex();
    const other = { at: 123, plan: 'team', windows: [{ name: '7 days', usedPercent: 42 }] };
    writeJson(files.quota(), { other });
    const acc = account({ id: 'refresh-persist', provider: 'codex', profileDir: process.env.OMNITRIX_HOME });
    const startedAt = Date.now();
    await refreshQuotas([acc], 60_000);
    const saved = JSON.parse(fs.readFileSync(files.quota(), 'utf8'));
    expect(saved.other).toEqual(other);
    expect(saved[acc.id]).toEqual({ at: expect.any(Number), plan: 'plus', windows: [{ name: '5 hours', usedPercent: 3, resetsAt: fake.resetsAt }] });
    expect(saved[acc.id].at).toBeGreaterThanOrEqual(startedAt);
    expect(fs.readFileSync(fake.counter, 'utf8')).toBe('start\n');
  });

  it('skips disabled, non-Codex and profileless accounts', async () => {
    const fake = installFakeCodex();
    await refreshQuotas([
      account({ id: 'refresh-disabled', provider: 'codex', enabled: false, profileDir: process.env.OMNITRIX_HOME }),
      account({ id: 'refresh-other-provider', profileDir: process.env.OMNITRIX_HOME }),
      account({ id: 'refresh-no-profile', provider: 'codex' }),
    ], 60_000);
    expect(fs.readFileSync(fake.counter, 'utf8')).toBe('');
    expect(loadQuotas()).toEqual({});
  });

  it('does not restart Codex inside maxAgeMs', async () => {
    const fake = installFakeCodex();
    const acc = account({ id: 'refresh-cached', provider: 'codex', profileDir: process.env.OMNITRIX_HOME });
    await refreshQuotas([acc], 60_000);
    await refreshQuotas([acc], 60_000);
    expect(loadQuotas()[acc.id]?.plan).toBe('plus');
    expect(fs.readFileSync(fake.counter, 'utf8')).toBe('start\n');
  });

  it('shares an in-flight read between concurrent calls', async () => {
    const fake = installFakeCodex();
    const acc = account({ id: 'refresh-concurrent', provider: 'codex', profileDir: process.env.OMNITRIX_HOME });
    await Promise.all([refreshQuotas([acc], 0), refreshQuotas([acc], 0)]);
    expect(loadQuotas()[acc.id]?.plan).toBe('plus');
    expect(fs.readFileSync(fake.counter, 'utf8')).toBe('start\n');
  });

  it('replaces old numbers with an empty reading when a read fails, and throttles the next attempt', async () => {
    const fake = installFakeCodex('exit');
    const acc = account({ id: 'refresh-failed', provider: 'codex', profileDir: process.env.OMNITRIX_HOME });
    writeJson(files.quota(), { [acc.id]: { at: 0, windows: [{ name: '5 hours', usedPercent: 100, resetsAt: Date.now() + 3600_000 }] } });
    await expect(refreshQuotas([acc], 60_000)).resolves.toBeUndefined();
    expect(loadQuotas()[acc.id]?.windows).toEqual([]);
    await expect(refreshQuotas([acc], 60_000)).resolves.toBeUndefined();
    expect(fs.readFileSync(fake.counter, 'utf8')).toBe('start\n');
  });
});
