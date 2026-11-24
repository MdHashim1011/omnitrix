import { execFile } from 'node:child_process';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { route, routeList, type RouteContext } from '../src/router.js';
import { defaultSettings, loadConfig } from '../src/store.js';
import type { Account, Config, TaskSpec } from '../src/types.js';
import { account, tempHome, writeConfig } from './helpers.js';

let home = '';
beforeEach(() => {
  home = tempHome();
});

// a strong model with a price, a weaker free one, and a local one
const paid = account({ id: 'paid', models: [{ ...makeModel('big', { skills: { coding: 9, reasoning: 9, writing: 9, longContext: 9, speed: 3, vision: 0 } }), inputPrice: 3, outputPrice: 15 }] });
const free = account({ id: 'free', models: [makeModel('small', { skills: { coding: 6, reasoning: 6, writing: 6, longContext: 6, speed: 8, vision: 0 } })] });
const local = account({ id: 'home', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', local: true, models: [makeModel('llama', { skills: { coding: 4, reasoning: 4, writing: 4, longContext: 4, speed: 5, vision: 0 } })] });

function ctx(accounts: Account[], settings: Partial<Config['settings']> = {}, latency?: Record<string, number>): RouteContext {
  return { config: { version: 1, accounts, settings: { ...defaultSettings, ...settings } }, health: {}, usage: {}, running: {}, stats: {}, ...(latency ? { latency } : {}) };
}
const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({ title: 't', type: 'review', prompt: 'p', privacy: 'public', ...over });
const order = (r: ReturnType<typeof route>) => r.candidates.map((c) => c.accountId);
const scores = (r: ReturnType<typeof route>) => r.candidates.map((c) => [c.accountId, c.score.toFixed(6)]);

describe('named routes', () => {
  it('"deep" ranks as the quality mode does, "cheap" as the saver mode, for this task only', () => {
    const all = [paid, free, local];
    expect(scores(route(task({ route: 'deep' }), ctx(all)))).toEqual(scores(route(task(), ctx(all, { mode: 'quality' }))));
    expect(scores(route(task({ route: 'cheap' }), ctx(all)))).toEqual(scores(route(task(), ctx(all, { mode: 'saver' }))));
    // the two really differ here: the paid model leads on depth, and loses when cost counts most
    expect(order(route(task({ route: 'deep' }), ctx(all)))[0]).toBe('paid');
    expect(order(route(task({ route: 'cheap' }), ctx(all)))[0]).not.toBe('paid');
  });

  it('"fast" ranks as a fast task does', () => {
    const latency = { 'paid/big': 20_000, 'free/small': 2_000, 'home/llama': 9_000 };
    const all = [paid, free, local];
    expect(scores(route(task({ route: 'fast' }), ctx(all, {}, latency)))).toEqual(scores(route(task({ fast: true }), ctx(all, {}, latency))));
    expect(order(route(task({ route: 'fast' }), ctx(all, {}, latency)))[0]).toBe('free');
  });

  it('"local" keeps the task on this computer, and says why the others were left out', () => {
    const r = route(task({ route: 'local' }), ctx([paid, free, local]));
    expect(order(r)).toEqual(['home']);
    expect(r.rejected.map((x) => x.accountId).sort()).toEqual(['free', 'paid']);
    expect(r.rejected[0]!.reason).toMatch(/route "local": models on this computer only/);
  });

  it('a route of your own limits the accounts or models and can set how to rank them', () => {
    const settings = { routes: { review: { description: 'second opinions', use: ['free', 'home/llama'], mode: 'quality' as const } } };
    const r = route(task({ route: 'review' }), ctx([paid, free, local], settings));
    expect(order(r)).toEqual(['free', 'home']);
    expect(r.rejected).toEqual([expect.objectContaining({ accountId: 'paid', reason: 'not in route "review"' })]);
    // the whole account is left out at once, not model by model
    expect(r.rejected[0]!.model).toBeUndefined();
    // a model of an allowed account that the route does not name is left out too
    const two = account({ id: 'home', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', local: true, models: [makeModel('llama'), makeModel('other')] });
    expect(route(task({ route: 'review' }), ctx([two], settings)).candidates.map((c) => c.model)).toEqual(['llama']);
  });

  it('a route of your own may replace a built-in one of the same name', () => {
    const settings = { routes: { local: { description: 'my free account', use: ['free'] } } };
    expect(order(route(task({ route: 'local' }), ctx([paid, free, local], settings)))).toEqual(['free']);
  });

  it('never loosens privacy: a private task still skips providers that train on prompts', () => {
    const trains = account({ id: 'trains', trainsOnData: true, models: [makeModel('m')] });
    const r = route(task({ route: 'cheap', privacy: 'private' }), ctx([trains, free]));
    expect(order(r)).toEqual(['free']);
  });

  it('lists every route with its description, own routes after the built-in ones', () => {
    const list = routeList({ ...defaultSettings, routes: { review: { description: 'second opinions' }, deep: { description: 'mine' } } });
    expect(list.map((r) => r.name)).toEqual(['fast', 'deep', 'cheap', 'local', 'review']);
    expect(list.find((r) => r.name === 'deep')!.description).toBe('mine');
    expect(list.every((r) => r.description.length > 0)).toBe(true);
  });
});

describe('dispatching with a route', () => {
  it('refuses an unknown route before queuing anything, and names the known ones', () => {
    writeConfig([free]);
    expect(() => new Engine().dispatch([task({ route: 'turbo' })])).toThrow(/route "turbo" is not known; the routes are fast, deep, cheap, local/);
  });

  it('a preview refuses an unknown route too, instead of ranking as if there were none', () => {
    writeConfig([free]);
    expect(() => new Engine().preview(task({ route: 'turbo' }))).toThrow(/route "turbo" is not known/);
  });

  it('keeps the route on the job', () => {
    writeConfig([free]);
    const [job] = new Engine().dispatch([task({ route: 'cheap' })]);
    expect(job!.task.route).toBe('cheap');
  });
});

describe('omnitrix routes', () => {
  const cli = path.resolve('dist/cli.js');
  const run = (...args: string[]) => new Promise<{ out: string; code: number }>((resolve) =>
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, OMNITRIX_HOME: home } }, (e, so, se) => resolve({ out: String(so) + String(se), code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 })));

  it('adds, lists and removes a route of your own', async () => {
    writeConfig([free, local]);
    const add = await run('routes', 'add', 'review', '--description', 'second opinions', '--use', 'free,home/llama', '--mode', 'quality');
    expect(add.code).toBe(0);
    expect(loadConfig().settings.routes?.review).toEqual({ description: 'second opinions', use: ['free', 'home/llama'], mode: 'quality' });
    const list = await run('routes');
    expect(list.out).toMatch(/deep\s+the strongest models/);
    expect(list.out).toMatch(/review\s+second opinions \(free, home\/llama; quality\)/);
    expect((await run('routes', 'remove', 'review')).code).toBe(0);
    expect(loadConfig().settings.routes?.review).toBeUndefined();
  }, 30_000);

  it('omnitrix route --route ranks with that route', async () => {
    writeConfig([paid, free, local]);
    const out = (await run('route', 'hello', '--route', 'local')).out;
    expect(out).toMatch(/1\. home\/llama/);
    expect(out).toMatch(/paid: route "local": models on this computer only/);
  }, 30_000);

  it('refuses a bad name, an unknown account and a missing description', async () => {
    writeConfig([free]);
    expect((await run('routes', 'add', 'Bad Name', '--description', 'x')).out).toMatch(/lowercase letters/);
    expect((await run('routes', 'add', 'r', '--description', 'x', '--use', 'nobody')).out).toMatch(/no account "nobody"/);
    expect((await run('routes', 'add', 'r')).code).not.toBe(0);
    expect(loadConfig().settings.routes).toBeUndefined();
  }, 30_000);
});
