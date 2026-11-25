import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameAccount, startDashboard } from '../src/dashboard.js';
import { loadConfig } from '../src/store.js';
import { account, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const label = (id: string) => loadConfig().accounts.find((a) => a.id === id)?.label;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('renaming an account', () => {
  it('saves a clean name, and refuses bad ones with the reason', () => {
    writeConfig([account({ id: 'gemini' })]);
    expect(renameAccount('gemini', '  🚀  Fast‮ Gemini ')).toEqual({ id: 'gemini', label: '🚀 Fast Gemini' });
    expect(label('gemini')).toBe('🚀 Fast Gemini');
    expect(renameAccount('gemini', '‍')).toEqual({ error: 'a name needs at least one visible character' });
    expect(renameAccount('nobody', 'x')).toEqual({ error: 'no such account' });
    expect(renameAccount(7, 'x')).toEqual({ error: 'no such account' });
    expect(label('gemini')).toBe('🚀 Fast Gemini');
  });

  it('takes a new name from the dashboard only with the page token', async () => {
    writeConfig([account({ id: 'groq', label: 'Groq' })]);
    const port = await freePort();
    const d = startDashboard(port);
    cleanups.push(() => d.close());
    await new Promise((r) => setTimeout(r, 100));
    const url = `http://127.0.0.1:${port}`;
    const token = /name="omnitrix-token" content="([0-9a-f]{32})"/.exec(await (await fetch(url)).text())![1]!;
    const post = (headers: Record<string, string>, body: unknown) => fetch(`${url}/api/rename`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await post({}, { id: 'groq', label: 'Hacked' })).status).toBe(403);
    expect((await post({ 'x-omnitrix-token': 'f'.repeat(32) }, { id: 'groq', label: 'Hacked' })).status).toBe(403);
    expect(label('groq')).toBe('Groq');
    const bad = await post({ 'x-omnitrix-token': token }, { id: 'groq', label: 'x'.repeat(49) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'a name can have at most 48 characters; this one has 49' });
    const ok = await post({ 'x-omnitrix-token': token }, { id: 'groq', label: '⚡ Groq 👨‍👩‍👧' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: 'groq', label: '⚡ Groq 👨‍👩‍👧' });
    expect(label('groq')).toBe('⚡ Groq 👨‍👩‍👧');
    // the page shows it at once, escaped like every name
    const state = await (await fetch(`${url}/api/status`)).json();
    expect(state.accounts.find((a: { id: string }) => a.id === 'groq').label).toBe('⚡ Groq 👨‍👩‍👧');
  });

  it('renames from the command line, with words given without quotes too', () => {
    writeConfig([account({ id: 'my-gemini', label: 'My Gemini' })]);
    const cli = path.resolve('dist/cli.js');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, OMNITRIX_HOME: home } });
    const r = run('rename', 'my-gemini', '🌟', 'Kiyotaka’s', 'Gemini');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('my-gemini is now called 🌟 Kiyotaka’s Gemini (was My Gemini)');
    expect(label('my-gemini')).toBe('🌟 Kiyotaka’s Gemini');
    const bad = run('rename', 'my-gemini', '   ');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('a name needs at least one visible character');
    expect(run('rename', 'nobody', 'x').stderr).toContain('no account "nobody"');
    // the older way checks names the same way
    expect(run('set', 'my-gemini', '--label', 'a\u0007b').status).toBe(0);
    expect(label('my-gemini')).toBe('a b');
    // a name saved by an older version can hold a terminal command; renaming it does not print that command
    writeConfig([account({ id: 'old', label: 'Old\u001b]0;pwned\u0007 name' })]);
    const out = run('rename', 'old', 'New');
    expect(out.stdout).toContain('old is now called New (was Old ]0;pwned name)');
    expect(out.stdout).not.toMatch(/\u001b|\u0007/);
  });
});
