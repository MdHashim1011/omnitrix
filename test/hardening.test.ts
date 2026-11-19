import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launch, runCli } from '../src/drivers/cli.js';
import { makeModel } from '../src/models.js';
import { loadHealth } from '../src/store.js';
import { loadStats } from '../src/stats.js';
import { account, tempHome } from './helpers.js';

const dist = path.resolve(__dirname, '..', 'dist');
const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Run the same small script in several omnitrix processes at once, all on one home folder. */
async function inParallel(processes: number, script: string): Promise<void> {
  const runs = Array.from({ length: processes }, (_, i) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(i)], { env: { ...process.env, OMNITRIX_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  }));
  await Promise.all(runs);
}

describe('files that several omnitrix processes change', () => {
  it('lose no verdict when several processes record them at once', async () => {
    fs.mkdirSync(home, { recursive: true });
    const url = JSON.stringify('file:///' + path.join(dist, 'stats.js').replace(/\\/g, '/'));
    await inParallel(4, `const { recordVerdict } = await import(${url}); for (let i = 0; i < 25; i++) recordVerdict('m', 'review', true);`);
    expect(loadStats()['m|review']!.ok).toBeCloseTo(100, 3);
  }, 60_000);

  it('lose no account health when several processes save it at once', async () => {
    fs.mkdirSync(home, { recursive: true });
    const url = JSON.stringify('file:///' + path.join(dist, 'store.js').replace(/\\/g, '/'));
    await inParallel(4, `const { saveHealth } = await import(${url}); const p = process.argv[1]; for (let i = 0; i < 25; i++) saveHealth({ ['a' + p + '-' + i]: { state: 'ready' } });`);
    expect(Object.keys(loadHealth())).toHaveLength(100);
  }, 60_000);
});

describe('starting a .cmd program on Windows', () => {
  it('keeps the program path out of the command text and quotes every argument', () => {
    const l = launch({ file: 'C:\\Program Files\\x\\tool.cmd', prefix: [], shell: true }, ['a b', 'x&y']);
    expect(l.verbatim).toBe(true);
    expect(l.args.join(' ')).not.toContain('Program Files');
    expect(l.args.at(-1)).toBe('""%OMNITRIX_PROGRAM%" "a b" "x&y""');
    expect(l.env.OMNITRIX_PROGRAM).toBe('C:\\Program Files\\x\\tool.cmd');
    expect(launch({ file: 'C:\\x\\tool.cmd', prefix: [], shell: true }, ['50%']).error).toMatch(/percent/);
    expect(launch({ file: '/usr/bin/tool', prefix: [], shell: false }, ['a b'])).toMatchObject({ file: '/usr/bin/tool', args: ['a b'], verbatim: false });
  });

  it.runIf(process.platform === 'win32')('runs an agent CLI whose .cmd file is in a folder with spaces', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix agent bin '));
    const script = path.join(bin, 'fake codex.js');
    fs.writeFileSync(script, `const fs=require('fs');const a=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(a[a.indexOf('-o')+1],'answer from a folder with spaces');console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}))});`);
    // not an npm shim, so omnitrix has to go through cmd.exe
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\nnode "${script}" %*\r\n`);
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    cleanups.push(() => {
      process.env.PATH = oldPath;
    });
    const acc = account({ id: 'cx', provider: 'codex', driver: 'cli', models: [makeModel('default')], profileDir: path.join(home, 'profiles', 'cx') });
    const r = await runCli({ account: acc, model: 'default', prompt: 'p', timeoutMs: 20_000 }, false);
    expect(r.text).toBe('answer from a folder with spaces');
  }, 30_000);
});

describe('the lock, after review', () => {
  it('takes over at once a lock whose process is gone', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    // a fresh lock, left by a process that no longer runs
    fs.writeFileSync(`${files.health()}.lock`, '999999 deadbeef');
    const t0 = Date.now();
    expect(withLock(files.health(), () => 'ran')).toBe('ran');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fs.existsSync(`${files.health()}.lock`)).toBe(false);
  });

  it('leaves alone a lock that a running process holds', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    // this test's own process counts as running; the lock is old by its time stamp but its holder lives
    const lock = `${files.health()}.lock`;
    fs.writeFileSync(lock, `${process.pid} cafebabe`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    withLock(files.health(), () => undefined);
    // it waited the full time for the holder before going ahead, and did not delete the holder's lock
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4500);
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid} cafebabe`);
    fs.rmSync(lock);
  }, 15_000);

  it('tells Windows not to look for programs in the current folder, for every program omnitrix starts', () => {
    const l = launch({ file: 'C:\\x\\tool.cmd', prefix: [], shell: true }, []);
    if (process.platform === 'win32') expect(l.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    const plain = launch({ file: 'C:\\x\\tool.exe', prefix: [], shell: false }, []);
    if (process.platform === 'win32') expect(plain.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });
});

describe('a process that dies while holding the lock', () => {
  it('does not hold up the next process', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    const lock = `${files.health()}.lock`;
    const url = JSON.stringify('file:///' + path.join(dist, 'store.js').replace(/\\/g, '/'));
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `const { withLock, files } = await import(${url}); withLock(files.health(), () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000));`], { env: { ...process.env, OMNITRIX_HOME: home }, stdio: 'ignore' });
    await expect.poll(() => fs.existsSync(lock) && fs.readFileSync(lock, 'utf8').length > 0, { timeout: 10_000 }).toBe(true);
    holder.kill('SIGKILL');
    await new Promise((r) => holder.on('exit', r));
    const t0 = Date.now();
    withLock(files.health(), () => undefined);
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 30_000);
});

describe('output of agent CLIs', () => {
  it.runIf(process.platform === 'win32')('keeps a character whole when the CLI prints it in two pieces', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-utf8-'));
    const script = path.join(bin, 'fake-codex.js');
    // the CLI fails and prints "café" to stderr, with the two bytes of "é" in separate writes
    fs.writeFileSync(script, [
      'process.stdin.resume();',
      "process.stdin.on('end', () => {",
      "  process.stderr.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]));",
      '  setTimeout(() => { process.stderr.write(Buffer.from([0xa9, 0x0a])); process.exit(1); }, 200);',
      '});',
    ].join('\n'));
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\nnode "${script}" %*\r\n`);
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    cleanups.push(() => {
      process.env.PATH = oldPath;
    });
    const acc = account({ id: 'cx', provider: 'codex', driver: 'cli', models: [makeModel('default')], profileDir: path.join(home, 'profiles', 'cx') });
    const err = await runCli({ account: acc, model: 'default', prompt: 'p', timeoutMs: 20_000 }, false).catch((e: Error) => e);
    expect(String(err)).toContain('café');
  }, 30_000);
});
