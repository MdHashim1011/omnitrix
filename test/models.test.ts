import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { loadConfig } from '../src/store.js';
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
