import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { files, loadConfig, saveConfig } from '../src/store.js';
import { fingerprint, readShared } from '../src/team.js';
import { readLedger, recordUsage } from '../src/usage.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
let closers: (() => Promise<void>)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
  closers = [];
});
afterEach(async () => {
  for (const c of closers) await c();
});

/** Write a team file whose one account talks to `url`, and join it as `user`. */
function joinTeam(url: string, over: Record<string, unknown> = {}, user = 'dev@acme.com') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-team-'));
  const file = path.join(dir, 'omnitrix.team.json');
  const team = {
    version: 1,
    name: 'Acme',
    accounts: [{ id: 'acme-api', provider: 'custom-openai', keyEnv: 'ACME_TEST_KEY', baseUrl: 'https://placeholder.invalid/v1', models: ['team-model'] }],
    prices: { 'team-model': { input: 2, output: 8 } },
    budgets: { usdPerDay: 1 },
    ...over,
  };
  const text = JSON.stringify(team, null, 2);
  fs.writeFileSync(file, text);
  const cfg = loadConfig();
  cfg.settings.team = { file, user, sha256: fingerprint(text) };
  saveConfig(cfg);
  // tests point the shared account at a local mock; the file itself must use https
  process.env.ACME_TEST_KEY = 'test-key';
  return { file, text, dir, url };
}

// Team accounts must use https, so tests reach the mock through a custom-openai account whose base URL is
// swapped after loading. This keeps the file's rule intact while letting requests go to 127.0.0.1.
function useMock(engine: Engine, url: string) {
  const original = engine.config.bind(engine);
  engine.config = () => {
    const cfg = original();
    for (const a of cfg.accounts) if (a.team) a.baseUrl = url;
    return cfg;
  };
}

describe('joined team', () => {
  it('loads the team accounts on every load and never saves them into the local config', () => {
    writeConfig([account({ id: 'mine' })]);
    joinTeam('x');
    expect(loadConfig().accounts.map((a) => a.id)).toEqual(['mine', 'acme-api']);
    saveConfig(loadConfig());
    const onDisk = JSON.parse(fs.readFileSync(files.config(), 'utf8'));
    expect(onDisk.accounts.map((a: { id: string }) => a.id)).toEqual(['mine']);
  });

  it('stops loading the team accounts when the file changes after joining', () => {
    writeConfig([account({ id: 'mine' })]);
    const { file, text } = joinTeam('x');
    fs.writeFileSync(file, text.replace('placeholder.invalid', 'attacker.example'));
    expect(loadConfig().accounts.map((a) => a.id)).toEqual(['mine']);
  });

  it('records who sent each team request, for which team, and its estimated cost', async () => {
    const api = await mockProvider(() => ({ json: chatReply('done', { prompt_tokens: 100_000, completion_tokens: 10_000 }) }));
    closers.push(api.close);
    writeConfig([]);
    const { dir } = joinTeam(api.url, { auditDir: undefined });
    const engine = new Engine();
    useMock(engine, api.url);
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('done');
    const rec = readLedger().find((r) => r.ok)!;
    // 100k input at $2 and 10k output at $8 per million tokens
    expect(rec).toMatchObject({ accountId: 'acme-api', user: 'dev@acme.com', team: 'Acme' });
    expect(rec.costUsd).toBeCloseTo(0.28, 6);
    expect(api.calls[0]!.headers.authorization).toBe('Bearer test-key');
    expect(fs.readdirSync(dir)).toEqual(['omnitrix.team.json']);
  });

  it('copies team records to the shared folder, one file per person', async () => {
    const api = await mockProvider(() => ({ json: chatReply('done') }));
    closers.push(api.close);
    writeConfig([]);
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-audit-'));
    joinTeam(api.url, { auditDir: shared });
    const engine = new Engine();
    useMock(engine, api.url);
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    await engine.wait([job!.id], 10);
    expect(fs.readdirSync(shared)).toEqual(['dev@acme.com.jsonl']);
    expect(readShared(shared)).toEqual([expect.objectContaining({ accountId: 'acme-api', user: 'dev@acme.com', ok: true })]);
  });

  it('skips team accounts once the person has spent their budget, and keeps their own accounts working', async () => {
    const api = await mockProvider(() => ({ json: chatReply('from team') }));
    const own = await mockProvider(() => ({ json: chatReply('from my own account') }));
    closers.push(api.close, own.close);
    writeConfig([account({ id: 'mine', baseUrl: own.url, priority: 5000 })]);
    joinTeam(api.url);
    recordUsage({ ts: Date.now(), accountId: 'acme-api', model: 'team-model', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1, costUsd: 1.2, user: 'dev@acme.com', team: 'Acme' });
    const engine = new Engine();
    useMock(engine, api.url);
    const preview = engine.preview({ title: 't', type: 'writing', prompt: 'q' });
    expect(preview.rejected).toContainEqual(expect.objectContaining({ accountId: 'acme-api', reason: expect.stringMatching(/your Acme budget for today is used up \(\$1\.20 of \$1\.00\)/) }));
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.accountId).toBe('mine');
    expect(api.calls).toHaveLength(0);
  });

  it('applies a person\'s own budget and a monthly budget', () => {
    writeConfig([]);
    joinTeam('x', { budgets: { usdPerDay: 1, usdPerMonth: 3, people: { 'dev@acme.com': { usdPerDay: 10 } } } });
    recordUsage({ ts: Date.now(), accountId: 'acme-api', model: 'team-model', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1, costUsd: 2, user: 'dev@acme.com', team: 'Acme' });
    expect(new Engine().preview({ title: 't', type: 'writing', prompt: 'q' }).candidates.map((c) => c.accountId)).toEqual(['acme-api']);
    recordUsage({ ts: Date.now(), accountId: 'acme-api', model: 'team-model', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1, costUsd: 1.5, user: 'dev@acme.com', team: 'Acme' });
    const r = new Engine().preview({ title: 't', type: 'writing', prompt: 'q' });
    expect(r.rejected).toContainEqual(expect.objectContaining({ accountId: 'acme-api', reason: expect.stringMatching(/budget for this month is used up \(\$3\.50 of \$3\.00\)/) }));
  });

  it('enforces an account budget across the whole team through the shared folder', () => {
    writeConfig([]);
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-audit-'));
    joinTeam('x', {
      budgets: undefined,
      auditDir: shared,
      accounts: [{ id: 'acme-api', provider: 'custom-openai', keyEnv: 'ACME_TEST_KEY', baseUrl: 'https://placeholder.invalid/v1', models: ['team-model'], usdPerDay: 5 }],
    });
    // another developer's spending, written from their machine
    fs.writeFileSync(path.join(shared, 'other@acme.com.jsonl'), JSON.stringify({ ts: Date.now(), accountId: 'acme-api', model: 'team-model', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1, costUsd: 5.5, user: 'other@acme.com', team: 'Acme' }) + '\n');
    const r = new Engine().preview({ title: 't', type: 'writing', prompt: 'q' });
    expect(r.rejected).toContainEqual(expect.objectContaining({ accountId: 'acme-api', reason: expect.stringMatching(/the team's daily limit for this account is used up \(\$5\.50 of \$5\.00\)/) }));
  });
});

describe('team commands', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, OMNITRIX_HOME: home }, encoding: 'utf8', timeout: 20_000 });

  function teamFile(over: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-team-'));
    const file = path.join(dir, 'omnitrix.team.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1, name: 'Acme',
      accounts: [{ id: 'acme-openai', provider: 'openai', keyEnv: 'ACME_OPENAI_KEY_UNSET', models: ['gpt-5.2'] }],
      prices: { 'gpt-5.2': { input: 1.25, output: 10 } }, budgets: { usdPerDay: 5 }, ...over,
    }));
    return file;
  }

  it('shows what a team file contains and joins only with --yes', () => {
    const file = teamFile();
    const review = run('team', 'join', file, '--as', 'dev@acme.com');
    expect(review.status).toBe(0);
    expect(review.stdout).toMatch(/acme-openai\s+openai\s+api\.openai\.com\s+key from ACME_OPENAI_KEY_UNSET \(not set on this computer\)/);
    expect(review.stdout).toMatch(/Nothing was changed/);
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
    const code = /review code: ([0-9a-f]{8})/.exec(review.stdout)![1]!;
    const join = run('team', 'join', file, '--as', 'dev@acme.com', '--yes', code);
    expect(join.stdout).toMatch(/joined Acme as dev@acme\.com/);
    const status = run('team');
    expect(status.stdout).toMatch(/Acme, as dev@acme\.com/);
    expect(status.stdout).toMatch(/today: \$0\.00 of \$5\.00/);
    expect(run('list').stdout).toContain('acme-openai');
    // a team account is managed by the file, not changed locally
    const set = run('set', 'acme-openai', '--concurrency', '9');
    expect(set.status).not.toBe(0);
    expect(set.stderr).toMatch(/managed by the team file/);
    const leave = run('team', 'leave');
    expect(leave.stdout).toMatch(/left Acme/);
    expect(run('list').stdout).not.toContain('acme-openai');
  }, 60_000);

  it('refuses a file that would share a subscription, and names the problem', () => {
    const r = run('team', 'join', teamFile({ accounts: [{ id: 'x', provider: 'codex', keyEnv: 'K', models: ['m'] }] }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/personal subscription/);
  });

  it('reports usage by person, account and model', () => {
    fs.mkdirSync(home, { recursive: true });
    const rec = (user: string, accountId: string, costUsd: number) => JSON.stringify({ ts: Date.now(), accountId, model: 'gpt-5.2', inputTokens: 1000, outputTokens: 100, ok: true, latencyMs: 1, costUsd, user, team: 'Acme' });
    fs.writeFileSync(path.join(home, 'usage.jsonl'), [rec('dev@acme.com', 'acme-openai', 0.5), rec('dev@acme.com', 'acme-openai', 0.25), rec('dev@acme.com', 'mine', 0)].join('\n') + '\n');
    const byPerson = run('usage', '--by', 'person');
    expect(byPerson.status).toBe(0);
    expect(byPerson.stdout).toMatch(/dev@acme\.com\s+3 requests\s+3\.3k tokens\s+\$0\.75/);
    expect(run('usage', '--by', 'account').stdout).toMatch(/acme-openai\s+2 requests\s+2\.2k tokens\s+\$0\.75/);
  });
});

describe('pool_status with a team', () => {
  it('shows the team, the person and their budget', async () => {
    writeConfig([]);
    joinTeam('x');
    recordUsage({ ts: Date.now(), accountId: 'acme-api', model: 'team-model', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1, costUsd: 0.4, user: 'dev@acme.com', team: 'Acme' });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...(process.env as Record<string, string>), OMNITRIX_HOME: home }, stderr: 'pipe' }));
    try {
      const status: any = await client.callTool({ name: 'pool_status', arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent.team).toMatchObject({ name: 'Acme', user: 'dev@acme.com', spentToday: 0.4, dayBudget: 1 });
      expect(status.content[0].text).toMatch(/team Acme as dev@acme\.com: \$0\.40 of \$1\.00 today/);
    } finally {
      await client.close();
    }
  }, 30_000);
});
