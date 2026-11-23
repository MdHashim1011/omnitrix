import { execFile } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { driftHint } from '../src/drift.js';
import { PROVIDERS } from '../src/providers.js';
import type { UsageRecord } from '../src/types.js';
import { account, tempHome, writeConfig } from './helpers.js';
import { recordUsage } from '../src/usage.js';

const T = Date.UTC(2026, 10, 20);
const rec = (ts: number, ok: boolean, errorKind?: UsageRecord['errorKind'], status?: number): UsageRecord => ({ ts, accountId: 'd', model: 'm', inputTokens: 1, outputTokens: 1, ok, latencyMs: 5, ...(errorKind ? { errorKind } : {}), ...(status ? { status } : {}) });

describe('a provider that may have changed its API', () => {
  it('is suspected when an account that worked fails three times in a row with errors that are not limits or sign-in', () => {
    const h = driftHint('d', [rec(T, true), rec(T + 1, false, 'bad_request', 400), rec(T + 2, false, 'unknown'), rec(T + 3, false, 'bad_request', 400)]);
    expect(h).toMatch(/^d worked until .*, then its last 3 requests failed \(bad_request 400, unknown\)/);
    expect(h).toMatch(/omnitrix test d/);
  });

  it('is not suspected for limits, sign-in, network trouble, fewer than three failures, or an account that never worked', () => {
    expect(driftHint('d', [rec(T, true), rec(T + 1, false, 'rate_limit'), rec(T + 2, false, 'quota'), rec(T + 3, false, 'auth')])).toBeUndefined();
    expect(driftHint('d', [rec(T, true), rec(T + 1, false, 'network'), rec(T + 2, false, 'timeout'), rec(T + 3, false, 'network')])).toBeUndefined();
    expect(driftHint('d', [rec(T, true), rec(T + 1, false, 'unknown'), rec(T + 2, false, 'unknown')])).toBeUndefined();
    expect(driftHint('d', [rec(T + 1, false, 'unknown'), rec(T + 2, false, 'unknown'), rec(T + 3, false, 'unknown')])).toBeUndefined();
    expect(driftHint('d', [rec(T, true), rec(T + 1, false, 'unknown'), rec(T + 2, false, 'unknown'), rec(T + 3, true)])).toBeUndefined();
  });

  it('counts only the failures since the last success, in time order', () => {
    const h = driftHint('d', [rec(T + 3, false, 'server', 500), rec(T, true), rec(T + 1, false, 'server', 500), rec(T + 2, false, 'server', 500)]);
    expect(h).toMatch(/last 3 requests failed \(server 500\)/);
  });

  it('doctor prints the hint', async () => {
    const home = tempHome();
    writeConfig([account({ id: 'd', local: true })]);
    for (const r of [rec(Date.now() - 4000, true), rec(Date.now() - 3000, false, 'bad_request', 400), rec(Date.now() - 2000, false, 'bad_request', 400), rec(Date.now() - 1000, false, 'bad_request', 400)]) recordUsage(r);
    const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const out = await new Promise<string>((resolve) => execFile(process.execPath, [cli, 'doctor'], { env: { ...process.env, OMNITRIX_HOME: home } }, (_e, so) => resolve(String(so))));
    expect(out).toMatch(/note  d worked until .*last 3 requests failed \(bad_request 400\)/);
  }, 30_000);
});

describe('providers tested with a real account', () => {
  it('are marked, and only those', () => {
    expect(PROVIDERS.filter((p) => p.tested).map((p) => p.id).sort()).toEqual(['codex', 'gemini', 'ollama']);
  });

  it('omnitrix providers says which were tested with a real account', async () => {
    tempHome();
    const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const out = await new Promise<string>((resolve) => execFile(process.execPath, [cli, 'providers'], (_e, so) => resolve(String(so))));
    expect(out).toMatch(/codex\s+ChatGPT \/ Codex CLI \(tested with a real account, November 2026\)/);
    expect(out).toMatch(/deepseek\s+DeepSeek\n/);
    expect(out).toMatch(/Only the providers marked as tested were run with a real account/);
  }, 30_000);
});
