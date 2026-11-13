import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { loadConfig, saveConfig } from '../src/store.js';
import { budgetBlocks, fingerprint, parseTeam, readShared } from '../src/team.js';
import { recordUsage } from '../src/usage.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
let home = '';
let closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  home = tempHome();
  closers = [];
});
afterEach(async () => {
  for (const c of closers) await c();
});

const base = { version: 1, name: 'Acme', accounts: [{ id: 'acme-api', provider: 'openai', keyEnv: 'ACME_OPENAI_KEY', models: ['gpt-5.2'] }], prices: { 'gpt-5.2': { input: 1, output: 8 } } };
const parse = (over: Record<string, unknown> = {}, account: Record<string, unknown> = {}) =>
  parseTeam(JSON.stringify({ ...base, ...over, accounts: [{ ...base.accounts[0], ...account }] }));

describe('team file hardening', () => {
  it('refuses hidden control characters in names, which could fake lines on the review screen', () => {
    expect(() => parse({ name: 'Acme\n  openai api.openai.com' })).toThrow(/name/);
    expect(() => parse({ name: 'Acme\u001b[8m' })).toThrow(/name/);
    expect(() => parse({}, { label: 'x‮y' })).toThrow(/label/);
  });

  it('refuses key variables that hold other credentials', () => {
    for (const keyEnv of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'PATH', 'HOME', 'USERPROFILE', 'DB_PASSWORD']) {
      expect(() => parse({}, { keyEnv }), keyEnv).toThrow(/not an AI provider key/);
    }
  });

  it('refuses a personal key variable sent to a server that is not the provider\'s own', () => {
    expect(() => parse({}, { keyEnv: 'OPENAI_API_KEY', baseUrl: 'https://proxy.example.com/v1' })).toThrow(/personal key/);
    // the provider's own server is allowed; join warns about it instead
    expect(parse({}, { keyEnv: 'OPENAI_API_KEY' }).accounts[0]!.keyEnv).toBe('OPENAI_API_KEY');
  });

  it('refuses to mark a provider that may train on prompts as safe for private work', () => {
    expect(() => parse({}, { provider: 'gemini', keyEnv: 'ACME_GEMINI_KEY', trainsOnData: false })).toThrow(/may train on prompts/);
    expect(parse({}, { provider: 'gemini', keyEnv: 'ACME_GEMINI_KEY', trainsOnData: true }).accounts[0]!.provider).toBe('gemini');
  });

  it('needs a valid https address, and one for providers that have no default', () => {
    expect(() => parse({}, { provider: 'custom-openai' })).toThrow(/baseUrl is required/);
    expect(() => parse({}, { baseUrl: 'https://[' })).toThrow(/baseUrl/);
    expect(() => parse({}, { baseUrl: 'ftp://host/v1' })).toThrow(/baseUrl/);
  });

  it('does not let names like __proto__ change how prices or budgets are read', () => {
    const team = parseTeam(JSON.stringify({ ...base, prices: { ...base.prices, __proto__: { input: 1, output: 1 } }, budgets: { usdPerDay: 2, people: { constructor: { usdPerDay: 9 } } } }));
    expect(Object.getPrototypeOf(team.prices)).toBeNull();
    expect(budgetBlocks(team, 'toString', [], [])).toEqual({});
  });
});

describe('shared folder hardening', () => {
  const now = Date.now();
  const good = (user: string, over: Record<string, unknown> = {}) => JSON.stringify({ ts: now, accountId: 'acme-api', model: 'gpt-5.2', inputTokens: 10, outputTokens: 10, ok: true, latencyMs: 1, costUsd: 1, user, team: 'Acme', ...over });

  it('ignores damaged or forged records instead of failing or switching limits off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-audit-'));
    fs.writeFileSync(path.join(dir, 'a@acme.com.jsonl'), [
      good('a@acme.com'),
      good('a@acme.com', { costUsd: 'abc' }),
      good('a@acme.com', { costUsd: '5' }),
      good('a@acme.com', { inputTokens: 'x' }),
      good('a@acme.com', { ts: now + 3_600_000 }),
      good('b@acme.com'), // written into someone else's file
      good('a@acme.com', { user: 'a\u001b]52;c;AAAA\u0007' }),
      good('a@acme.com').replace('"costUsd":1', '"costUsd":-1e999'),
      good('a@acme.com').replace('"costUsd":1', '"costUsd":1e999'),
    ].join('\n') + '\n');
    const records = readShared(dir);
    expect(records).toHaveLength(1);
    const team = parseTeam(JSON.stringify({ ...base, accounts: [{ ...base.accounts[0], usdPerDay: 1 }] }));
    expect(budgetBlocks(team, 'me@acme.com', [], records)['acme-api']).toMatch(/daily limit/);
  });

  it('skips folders and oversized files that only look like logs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-audit-'));
    fs.mkdirSync(path.join(dir, 'x.jsonl'));
    const big = path.join(dir, 'big@acme.com.jsonl');
    fs.writeFileSync(big, good('big@acme.com') + '\n');
    fs.truncateSync(big, 11 * 1024 * 1024);
    fs.writeFileSync(path.join(dir, 'ok@acme.com.jsonl'), good('ok@acme.com') + '\n');
    expect(readShared(dir).map((r) => r.user)).toEqual(['ok@acme.com']);
  });
});

describe('budgets in practice', () => {
  function join(over: Record<string, unknown>, user = 'dev@acme.com') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-team-'));
    const file = path.join(dir, 'omnitrix.team.json');
    const text = JSON.stringify({ version: 1, name: 'Acme', accounts: [{ id: 'acme-api', provider: 'custom-openai', keyEnv: 'ACME_TEST_KEY', baseUrl: 'https://placeholder.invalid/v1', models: ['team-model'] }], prices: { 'team-model': { input: 2, output: 8 } }, ...over });
    fs.writeFileSync(file, text);
    const cfg = loadConfig();
    cfg.settings.team = { file, user, sha256: fingerprint(text) };
    saveConfig(cfg);
    process.env.ACME_TEST_KEY = 'test-key';
  }
  function useMock(engine: Engine, url: string) {
    const original = engine.config.bind(engine);
    engine.config = () => {
      const cfg = original();
      for (const a of cfg.accounts) if (a.team) a.baseUrl = url;
      return cfg;
    };
  }

  it('never blocks your own account that happens to share an id with a team account', () => {
    writeConfig([account({ id: 'acme-api' })]);
    join({ budgets: { usdPerDay: 1 } });
    recordUsage({ ts: Date.now(), accountId: 'acme-api', model: 'team-model', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1, costUsd: 2, user: 'dev@acme.com', team: 'Acme' });
    const r = new Engine().preview({ title: 't', type: 'writing', prompt: 'q' });
    expect(r.candidates.map((c) => c.accountId)).toEqual(['acme-api']);
  });

  it('reserves the cost of running requests, so a burst cannot run far past a budget', async () => {
    const api = await mockProvider(() => ({ json: chatReply('done'), delayMs: 500 }));
    closers.push(api.close);
    writeConfig([]);
    // 16k output tokens at $8 per million is about $0.13 reserved per running request
    join({ budgets: { usdPerDay: 1 }, accounts: [{ id: 'acme-api', provider: 'custom-openai', keyEnv: 'ACME_TEST_KEY', baseUrl: 'https://placeholder.invalid/v1', models: ['team-model'], concurrency: 4 }] });
    recordUsage({ ts: Date.now(), accountId: 'acme-api', model: 'team-model', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1, costUsd: 0.9, user: 'dev@acme.com', team: 'Acme' });
    const engine = new Engine();
    useMock(engine, api.url);
    const jobs = engine.dispatch([1, 2, 3, 4].map((n) => ({ title: `t${n}`, type: 'writing' as const, prompt: `q${n}` })));
    await engine.wait(jobs.map((j) => j.id), 10);
    expect(api.calls).toHaveLength(1);
  });

  it('keeps team accounts as loaded, whatever a caller does to its copy', () => {
    writeConfig([]);
    join({});
    const first = loadConfig().accounts.find((a) => a.team)!;
    first.baseUrl = 'https://somewhere-else.example';
    first.models = [];
    const again = loadConfig().accounts.find((a) => a.team)!;
    expect(again.baseUrl).toBe('https://placeholder.invalid/v1');
    expect(again.models.map((m) => m.id)).toEqual(['team-model']);
  });
});

describe('team join review code', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, OMNITRIX_HOME: home }, encoding: 'utf8', timeout: 20_000 });
  function teamFile(over: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-team-'));
    const file = path.join(dir, 'omnitrix.team.json');
    fs.writeFileSync(file, JSON.stringify({ ...base, budgets: { usdPerDay: 5 }, ...over }));
    return file;
  }

  it('joins only with the review code of the exact contents that were shown', () => {
    const file = teamFile();
    const review = run('team', 'join', file, '--as', 'dev@acme.com');
    const code = /review code: ([0-9a-f]{8})/.exec(review.stdout)![1]!;
    expect(run('team', 'join', file, '--as', 'dev@acme.com', '--yes').status).not.toBe(0);
    expect(run('team', 'join', file, '--as', 'dev@acme.com', '--yes', '00000000').stderr).toMatch(/review code/);
    // the file changes between the review and the join
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"Acme"', '"Acme Corp"'));
    const stale = run('team', 'join', file, '--as', 'dev@acme.com', '--yes', code);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toMatch(/changed since/);
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
    const fresh = /review code: ([0-9a-f]{8})/.exec(run('team', 'join', file, '--as', 'dev@acme.com').stdout)![1]!;
    expect(run('team', 'join', file, '--as', 'dev@acme.com', '--yes', fresh).stdout).toMatch(/joined Acme Corp/);
  }, 60_000);

  it('warns about personal key variables, other servers and models without a price', () => {
    const file = teamFile({ accounts: [{ id: 'acme-api', provider: 'openai', keyEnv: 'OPENAI_API_KEY', models: ['gpt-5.2', 'gpt-5.2-mini'] }] });
    const r = run('team', 'join', file);
    expect(r.stdout).toMatch(/OPENAI_API_KEY usually holds a personal key/);
    expect(r.stdout).toMatch(/no price for gpt-5\.2-mini/);
    const proxy = run('team', 'join', teamFile({ accounts: [{ id: 'acme-api', provider: 'openai', keyEnv: 'ACME_OPENAI_KEY', baseUrl: 'https://llm-proxy.acme.com/v1', models: ['gpt-5.2'] }] }));
    expect(proxy.stdout).toMatch(/llm-proxy\.acme\.com.*not the provider's own address/);
  }, 30_000);
});
