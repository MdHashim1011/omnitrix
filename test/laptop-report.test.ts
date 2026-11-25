import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedVersion, updateNote } from '../src/installed.js';
import { codexModelInfo, upgradeCodexModels } from '../src/drivers/index.js';
import { makeModel } from '../src/models.js';
import { loadConfig } from '../src/store.js';
import { dashboardLine } from '../src/mcp.js';
import { fit } from '../src/router.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// From the owner's check of 0.8.8 on his laptop: the router chose gpt-6.2-astra over gpt-6.2-sol, which
// Codex lists first and uses by default; the dashboard opened in Chrome and then again in Claude's browser
// pane; Claude kept running omnitrix 0.2.1 after 0.8.8 was installed; and PowerShell showed the routing
// line of `omnitrix run` as an error.

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// the order of the owner's plan, as Codex lists it
const PLAN = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

describe('the models of a ChatGPT plan', () => {
  it('rank in the order Codex lists them within a generation, so its default comes first', () => {
    const models = codexModelInfo(PLAN);
    const by = (id: string) => models.find((m) => m.id === id)!;
    for (const type of ['review', 'writing', 'code', 'reasoning'] as const) {
      const best = [...models].sort((a, b) => fit(b.skills, type) - fit(a.skills, type))[0]!;
      expect(best.id).toBe('gpt-6.2-sol');
    }
    expect(fit(by('gpt-6.2-astra').skills, 'review')).toBeLessThan(fit(by('gpt-6.2-sol').skills, 'review'));
    // a later model of the same generation drops below the first; one that the names already rank lower keeps its own scores
    expect(by('gpt-6.2-astra').skills.coding).toBe(by('gpt-6.2-sol').skills.coding - 1);
    expect(by('gpt-6-luna').skills.coding).toBeLessThan(by('gpt-6-sol').skills.coding);
    // an older generation stays below the newest one's first model, never level with it
    expect(fit(by('gpt-6-astra').skills, 'review')).toBeLessThan(fit(by('gpt-6.2-sol').skills, 'review'));
    // each later model is measured against the first of its generation, not against the one before it
    const [, luna, astra] = codexModelInfo(['gpt-6.2-sol', 'gpt-6.2-luna', 'gpt-6.2-astra']);
    expect(astra!.skills.coding).toBe(by('gpt-6.2-sol').skills.coding - 1);
    expect(luna!.skills.coding).toBeLessThan(astra!.skills.coding);
    // a list in which the stronger name comes first keeps it first
    const [first, second] = codexModelInfo(['gpt-6.2-astra', 'gpt-6.2-sol']);
    expect(first!.skills.coding).toBeGreaterThan(second!.skills.coding);
  });
});

describe('a ChatGPT account saved with the scores of an older omnitrix', () => {
  it('gets the current scores when omnitrix starts, without a manual refresh', () => {
    // as 0.8.8 saved them: by name alone, so astra ranked above sol
    const old = PLAN.map((id) => makeModel(id));
    expect(old[1]!.skills.coding).toBeGreaterThan(old[0]!.skills.coding);
    const handSet = PLAN.map((id) => makeModel(id));
    handSet[1] = { ...handSet[1]!, skills: { ...handSet[1]!.skills, coding: 10 }, basis: 'manual' };
    writeConfig([
      account({ id: 'old', provider: 'codex', driver: 'cli', models: old }),
      account({ id: 'tuned', provider: 'codex', driver: 'cli', models: handSet }),
    ]);
    expect(upgradeCodexModels()).toEqual(['old']);
    const after = loadConfig().accounts;
    const models = after.find((a) => a.id === 'old')!.models;
    expect(models.map((m) => m.skills)).toEqual(codexModelInfo(PLAN).map((m) => m.skills));
    expect(models[0]!.skills.coding).toBeGreaterThan(models[1]!.skills.coding);
    // scores the user set by hand stay as they are, and so do the other models of that account
    expect(after.find((a) => a.id === 'tuned')!.models).toEqual(handSet);
    // nothing left to change the second time
    expect(upgradeCodexModels()).toEqual([]);
  });
});

describe('the dashboard address that Claude gets', () => {
  it('tells Claude not to open a second page when one is open', () => {
    expect(dashboardLine('http://127.0.0.1:4590', 1)).toMatch(/already open .*do not open it again/);
    expect(dashboardLine('http://127.0.0.1:4590', 0)).toMatch(/no page shows it/);
    expect(dashboardLine(null, 0)).toBeUndefined();
  });
});

describe('a running omnitrix that is older than the installed one', () => {
  it('reads the installed version from the package beside it', () => {
    const dir = path.join(home, 'pkg');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'omnitrix', version: '0.8.9' }));
    expect(installedVersion(path.join(dir, 'dist'))).toBe('0.8.9');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }));
    expect(installedVersion(path.join(dir, 'dist'))).toBeUndefined();
    expect(installedVersion(path.join(home, 'nowhere'))).toBeUndefined();
  });

  it('asks for a restart only when the installed version is newer', () => {
    expect(updateNote('0.2.1', '0.8.8')).toMatch(/0\.8\.8 is installed, but this omnitrix still runs 0\.2\.1.*restart/);
    expect(updateNote('0.8.8', '0.8.8')).toBeUndefined();
    expect(updateNote('0.8.9', '0.8.8')).toBeUndefined();
    expect(updateNote('0.8.8', undefined)).toBeUndefined();
  });
});

describe('omnitrix run --quiet', () => {
  const cli = path.resolve('dist/cli.js');
  const run = (...args: string[]) => new Promise<{ out: string; err: string; code: number }>((resolve) =>
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, OMNITRIX_HOME: home, OMNITRIX_NO_BROWSER: '1' } }, (e, so, se) => resolve({ out: String(so), err: String(se), code: e ? 1 : 0 })));

  it('prints only the answer, so PowerShell shows no error for the routing line', async () => {
    const p = await mockProvider(() => ({ json: chatReply('the answer') }));
    cleanups.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true })]);
    const quiet = await run('run', 'hello', '--quiet');
    expect(quiet).toMatchObject({ code: 0, err: '' });
    expect(quiet.out.trim()).toBe('the answer');
    const loud = await run('run', 'hello');
    expect(loud.err).toMatch(/-> a\//);
  }, 60_000);

  it('shows the current Codex scores from the terminal too, without a refresh', async () => {
    writeConfig([account({ id: 'old', provider: 'codex', driver: 'cli', models: PLAN.map((id) => makeModel(id)) })]);
    const shown = await run('models', 'old');
    const coding = (id: string) => Number(shown.out.split('\n').find((l) => l.startsWith(id + ' '))!.trim().split(/\s+/)[1]);
    expect(coding('gpt-6.2-sol')).toBeGreaterThan(coding('gpt-6.2-astra'));
  }, 60_000);
});
