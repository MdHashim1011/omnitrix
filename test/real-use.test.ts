import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recentJobs, startDashboard } from '../src/dashboard.js';
import { dashboardOnce } from '../src/mcp.js';
import { codexModels } from '../src/drivers/cli.js';
import { codexModelInfo, upgradeCodexModels } from '../src/drivers/index.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { files, loadConfig, writeJson } from '../src/store.js';
import type { Job } from '../src/types.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// Problems found while using omnitrix on a real project: the ChatGPT account showed only "default", the
// job list and the account card disagreed on tokens, and finished jobs could not be cleared from the list.

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A Codex profile folder whose model list is the one Codex saves after its first run. */
function codexProfile(models: unknown, name = 'chatgpt'): string {
  const dir = path.join(home, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  if (models !== undefined) fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({ fetched_at: 'x', models }));
  return dir;
}
const listed = [
  { slug: 'gpt-6.1-terra', visibility: 'list', priority: 3 },
  { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
  { slug: 'gpt-6.2-sol', visibility: 'list', priority: 1 },
  { slug: 'gpt-6.2-astra', visibility: 'list', priority: 2 },
  { slug: 'bad name; rm -rf', visibility: 'list', priority: 5 },
];

describe('the models of a ChatGPT (Codex) account', () => {
  it('come from the list Codex saves, newest first, without hidden models or odd names', () => {
    const chatgpt = account({ id: 'chatgpt', provider: 'codex', driver: 'cli', profileDir: codexProfile(listed), models: [makeModel('default')] });
    expect(codexModels(chatgpt)).toEqual(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra']);
    expect(codexModels({ ...chatgpt, profileDir: codexProfile(undefined, 'fresh') })).toEqual([]);
    fs.writeFileSync(path.join(chatgpt.profileDir!, 'models_cache.json'), 'not json');
    expect(codexModels(chatgpt)).toEqual([]);
  });

  it('replace "default" once Codex has saved its list, and leave chosen models alone', () => {
    const dir = codexProfile(listed);
    writeConfig([
      account({ id: 'chatgpt', provider: 'codex', driver: 'cli', profileDir: dir, models: [makeModel('default')] }),
      account({ id: 'mine', provider: 'codex', driver: 'cli', profileDir: dir, models: [makeModel('gpt-6-luna')] }),
      account({ id: 'pinned', provider: 'codex', driver: 'cli', profileDir: dir, models: [{ ...makeModel('default'), pinned: true }] }),
    ]);
    expect(upgradeCodexModels()).toEqual(['chatgpt']);
    const accounts = loadConfig().accounts;
    expect(accounts.find((a) => a.id === 'chatgpt')!.models.map((m) => m.id)).toEqual(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra']);
    // the real models get estimated scores; "default" was untested
    expect(accounts.find((a) => a.id === 'chatgpt')!.models.every((m) => m.basis === 'estimated')).toBe(true);
    expect(accounts.find((a) => a.id === 'mine')!.models.map((m) => m.id)).toEqual(['gpt-6-luna']);
    expect(accounts.find((a) => a.id === 'pinned')!.models.map((m) => m.id)).toEqual(['default']);
    expect(upgradeCodexModels()).toEqual([]);
  });
});

describe('opening the dashboard at the first task', () => {
  it('happens once per session, never with nobody to look, and not when turned off', async () => {
    writeConfig([account({ id: 'a' })]);
    const engine = new Engine();
    let opened = 0;
    const show = async () => void opened++;
    const saved = process.env.OMNITRIX_NO_BROWSER;
    const savedCi = process.env.CI;
    delete process.env.CI;
    cleanups.push(() => {
      process.env.OMNITRIX_NO_BROWSER = saved;
      if (savedCi !== undefined) process.env.CI = savedCi;
    });
    process.env.OMNITRIX_NO_BROWSER = '1';
    dashboardOnce(engine, show)();
    expect(opened).toBe(0);
    delete process.env.OMNITRIX_NO_BROWSER;
    const once = dashboardOnce(engine, show);
    once();
    once();
    expect(opened).toBe(1);
    writeConfig([account({ id: 'a' })], { openDashboard: 'off' });
    dashboardOnce(engine, show)();
    expect(opened).toBe(1);
  });
});

describe('scores of the Codex models', () => {
  it('put the newest generation above an older one of the same tier', () => {
    const [newest, sameMajor, older] = codexModelInfo(['gpt-6.2-astra', 'gpt-6-astra', 'gpt-5.6-astra']);
    expect(newest!.skills.coding - sameMajor!.skills.coding).toBe(1);
    expect(newest!.skills.coding - older!.skills.coding).toBe(2);
    // speed and vision do not age
    expect(older!.skills.speed).toBe(newest!.skills.speed);
  });
});

describe('the effort an account works at', () => {
  it('applies when a task does not set one, and the job records it', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok') }));
    cleanups.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true, effort: 'high' })]);
    const engine = new Engine();
    const [plain, own] = engine.dispatch([{ title: 'a', type: 'writing', prompt: 'p' }, { title: 'b', type: 'writing', prompt: 'q', effort: 'low' }]);
    const done = await engine.wait([plain!.id, own!.id], 10);
    expect(done.map((j) => j.effort)).toEqual(['high', 'low']);
    expect(p.calls.map((c) => c.body.reasoning_effort).sort()).toEqual(['high', 'low']);
  });
});

describe('tokens in the job list', () => {
  it('count every attempt and the check, as the account totals do', async () => {
    let n = 0;
    // the first attempt fails after the provider counted tokens; the second answers
    const p = await mockProvider(() => (++n === 1 ? { json: chatReply('', { prompt_tokens: 300, completion_tokens: 0 }) } : { json: chatReply('fine', { prompt_tokens: 100, completion_tokens: 20 }) }));
    cleanups.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true, models: [makeModel('one'), makeModel('two')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('done');
    expect(done!.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    const row = recentJobs(engine).find((r) => r.id === job!.id)!;
    expect(row.spent).toEqual({ tokens: 420, check: 0 });
  });
});

describe('removing jobs from the dashboard', () => {
  async function freePort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }
  const job = (id: string, status: Job['status']): Job => ({ id, task: { title: id, type: 'writing', prompt: 'p' }, status, createdAt: Date.now(), updatedAt: Date.now(), attempts: [], pid: process.pid });

  it('hides finished jobs only, keeps their records, and can remove every failed one at once', () => {
    writeConfig([account({ id: 'a' })]);
    for (const [id, st] of [['jaaaaaaaaaaa1', 'done'], ['jaaaaaaaaaaa2', 'failed'], ['jaaaaaaaaaaa3', 'cancelled'], ['jaaaaaaaaaaa4', 'running']] as const) {
      writeJson(path.join(files.jobs(), `${id}.json`), job(id, st));
    }
    const engine = new Engine();
    expect(engine.hideJobs({ ids: ['jaaaaaaaaaaa1', 'jaaaaaaaaaaa4', '../x'] })).toBe(1);
    expect(recentJobs(engine).map((r) => r.id).sort()).toEqual(['jaaaaaaaaaaa2', 'jaaaaaaaaaaa3', 'jaaaaaaaaaaa4']);
    expect(engine.hideJobs({ failed: true })).toBe(2);
    expect(recentJobs(engine).map((r) => r.id)).toEqual(['jaaaaaaaaaaa4']);
    // the record stays, so Claude can still read the result
    expect(engine.getJob('jaaaaaaaaaaa1')).toMatchObject({ status: 'done', hidden: true });
  });

  it('takes the request only from its own page', async () => {
    writeConfig([account({ id: 'a' })]);
    writeJson(path.join(files.jobs(), 'jaaaaaaaaaab1.json'), job('jaaaaaaaaaab1', 'failed'));
    const port = await freePort();
    const d = startDashboard(port);
    cleanups.push(() => d.close());
    await new Promise((r) => setTimeout(r, 100));
    const url = `http://127.0.0.1:${port}`;
    const page = await (await fetch(url)).text();
    const token = /name="omnitrix-token" content="([0-9a-f]{32})"/.exec(page)![1]!;
    const post = (headers: Record<string, string>, body = '{"failed":true}') => fetch(`${url}/api/hide`, { method: 'POST', headers, body });
    expect((await post({ 'content-type': 'application/json' })).status).toBe(403);
    expect((await post({ 'content-type': 'application/json', 'x-omnitrix-token': 'f'.repeat(32) })).status).toBe(403);
    expect((await post({ 'content-type': 'text/plain', 'x-omnitrix-token': token })).status).toBe(403);
    expect((await post({ 'content-type': 'application/json', 'x-omnitrix-token': token, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await fetch(`${url}/api/hide`, { headers: { 'x-omnitrix-token': token } })).status).toBe(403);
    expect((await fetch(`${url}/api/hide`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-omnitrix-token': token }, body: '{"failed":true}' })).status).toBe(403);
    const ok = await post({ 'content-type': 'application/json', 'x-omnitrix-token': token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ hidden: 1 });
    expect(new Engine().getJob('jaaaaaaaaaab1')!.hidden).toBe(true);
  });
});
