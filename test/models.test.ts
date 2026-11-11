import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { loadConfig, loadHealth, saveHealth } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
const closers: (() => unknown)[] = [];
beforeEach(() => tempHome());
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const gone = { status: 404, json: { error: { code: 404, message: 'This model models/old-flash is no longer available to new users.', status: 'NOT_FOUND' } } };

function runCli(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('models that stop answering', () => {
  const overloaded = { status: 503, json: { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } } };

  it('pauses only the failing model and finishes the job on another model of the same account', async () => {
    const p = await mockProvider((call) => (call.body.model === 'busy-model' ? overloaded : { json: chatReply('from the calm model') }));
    closers.push(p.close);
    writeConfig([account({ id: 'g', baseUrl: p.url, local: true, models: [makeModel('busy-model'), makeModel('calm-model')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q', use: 'g' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('done');
    expect(done!.model).toBe('calm-model');
    // the account itself stays usable; only the busy model takes a break
    expect(engine.pool()[0]!.state).toBe('ready');
    const health = loadHealth();
    expect(health['g/busy-model']).toMatchObject({ state: 'cooling' });
    expect(health['g/busy-model']!.until!).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it('routes around a paused model', () => {
    writeConfig([account({ id: 'g', models: [makeModel('busy-model'), makeModel('calm-model')] })]);
    saveHealth({ 'g/busy-model': { state: 'cooling', until: Date.now() + 300_000, reason: 'overloaded' } });
    const { candidates, rejected } = new Engine().preview({ title: 't', type: 'writing', prompt: 'q' });
    expect(candidates.map((c) => c.model)).toEqual(['calm-model']);
    expect(rejected).toContainEqual(expect.objectContaining({ accountId: 'g', model: 'busy-model' }));
  });

  it('tries another account before the rest of a failing account', async () => {
    const down = await mockProvider(() => overloaded);
    const up = await mockProvider(() => ({ json: chatReply('from the healthy account') }));
    closers.push(down.close, up.close);
    writeConfig([
      account({ id: 'down', baseUrl: down.url, local: true, priority: 0, models: [makeModel('m1'), makeModel('m2'), makeModel('m3')] }),
      account({ id: 'up', baseUrl: up.url, local: true, priority: 1, models: [makeModel('m1')] }),
    ]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('done');
    expect(done!.accountId).toBe('up');
    expect(down.calls).toHaveLength(1);
  });

  it('shows an account as cooling while every one of its models is paused', () => {
    writeConfig([account({ id: 'g', models: [makeModel('a'), makeModel('b')] })]);
    const soon = Date.now() + 120_000;
    saveHealth({ 'g/a': { state: 'cooling', until: soon, reason: 'x' }, 'g/b': { state: 'cooling', until: soon + 60_000, reason: 'x' } });
    const view = new Engine().pool()[0]!;
    expect(view.state).toBe('cooling');
    expect(view.until).toBe(soon);
    saveHealth({ 'g/b': { state: 'cooling', until: Date.now() - 1, reason: 'x' } });
    expect(new Engine().pool()[0]!.state).toBe('ready');
  });

  it('forgets model pauses that have run out', () => {
    saveHealth({ 'g/old': { state: 'cooling', until: Date.now() - 1000, reason: 'x' }, 'g/new': { state: 'cooling', until: Date.now() + 60_000, reason: 'x' } });
    saveHealth({ g: { state: 'ready' } });
    const health = loadHealth();
    expect(health['g/old']).toBeUndefined();
    expect(health['g/new']).toBeDefined();
  });

  it('still pauses a one-model account after a server error', async () => {
    const p = await mockProvider(() => overloaded);
    closers.push(p.close);
    writeConfig([account({ id: 'solo', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(engine.pool()[0]!.state).toBe('cooling');
    expect(p.calls).toHaveLength(1);
  });
});

describe('retired models', () => {
  it('moves a job to the next model and removes the retired one from the account', async () => {
    const p = await mockProvider((call) => (call.body.model === 'models/old-flash' ? gone : { json: chatReply('from the new model') }));
    closers.push(p.close);
    writeConfig([account({ id: 'g', baseUrl: p.url, local: true, models: [makeModel('models/old-flash'), makeModel('models/new-flash')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('done');
    expect(done!.model).toBe('models/new-flash');
    expect(loadConfig().accounts[0]!.models.map((m) => m.id)).toEqual(['models/new-flash']);
  });

  it('omnitrix test skips a retired model and exits cleanly', async () => {
    const p = await mockProvider((call) => (call.body.model === 'models/old-flash' ? gone : { json: chatReply('OK') }));
    closers.push(p.close);
    writeConfig([account({ id: 'g', baseUrl: p.url, local: true, models: [makeModel('models/old-flash'), makeModel('models/new-flash')] })]);
    const r = await runCli(['test', 'g']);
    expect(r.out).toMatch(/no longer available/);
    expect(r.out).toMatch(/ok in/);
    expect(r.code).toBe(0);
  }, 30_000);

  it('omnitrix test exits with code 1, and no crash, when the request fails', async () => {
    const p = await mockProvider(() => ({ status: 500, json: { error: { message: 'boom' } } }));
    closers.push(p.close);
    writeConfig([account({ id: 'g', baseUrl: p.url, local: true })]);
    const r = await runCli(['test', 'g']);
    expect(r.out).toMatch(/failed/);
    expect(r.out).not.toMatch(/Assertion failed/);
    expect(r.code).toBe(1);
  }, 30_000);
});
