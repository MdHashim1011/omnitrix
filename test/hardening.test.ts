import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps waiting while the lock passes from one holder to the next', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    // On a slow computer several busy processes can keep a waiter out for more than 5 s; they are working,
    // not stuck, so going ahead without the lock would overwrite one of their changes.
    const lock = `${files.health()}.lock`;
    const released = path.join(home, 'released');
    const script = `const fs=require('fs');const [lock,released]=process.argv.slice(1);let n=0;fs.writeFileSync(lock,process.pid+' h0');const t=setInterval(()=>{n++;if(n<7){fs.writeFileSync(lock,process.pid+' h'+n);return}clearInterval(t);fs.writeFileSync(released,'1');fs.rmSync(lock)},1000);`;
    const holder = spawn(process.execPath, ['-e', script, lock, released], { stdio: 'ignore' });
    cleanups.push(() => holder.kill());
    await expect.poll(() => fs.existsSync(lock), { timeout: 10_000 }).toBe(true);
    expect(withLock(files.health(), () => fs.existsSync(released))).toBe(true);
  }, 30_000);

  it('does not count time when the waiter itself was paused', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    // found by a review through omnitrix: a waiter that the system paused for longer than the limit gave up
    // at its next look, although the holder had not kept the lock that long
    const lock = `${files.health()}.lock`;
    fs.writeFileSync(lock, `${process.pid} cafebabe`);
    const real = Date.now.bind(Date);
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + (++calls > 3 ? 6_000 : 0));
    cleanups.push(() => clock.mockRestore());
    const t0 = performance.now();
    withLock(files.health(), () => undefined);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(4000);
    fs.rmSync(lock);
  }, 15_000);

  it.each([1, 2])('never deletes the fresh lock of another waiter that took over the same abandoned lock (after look %i)', async (at) => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    // found by a review through omnitrix: two waiters both find a lock whose process is gone; the first deletes
    // it and takes the lock, then the second deletes the first one's fresh lock and both change the file at once
    const lock = `${files.health()}.lock`;
    fs.writeFileSync(lock, '999999 deadbeef');
    const read = fs.readFileSync.bind(fs) as (...a: unknown[]) => unknown;
    let reads = 0;
    let otherHolds = false;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      const out = read(...args);
      if (args[0] !== lock) return out;
      reads++;
      if (otherHolds && reads === at + 3) {
        // the other waiter finishes its change and lets go
        fs.rmSync(lock, { force: true });
        otherHolds = false;
      }
      if (reads === at) {
        // the other waiter, between this waiter's last look and its delete, follows the same rules
        let guard: number | undefined;
        try {
          guard = fs.openSync(`${lock}.takeover`, 'wx');
        } catch {
          /* this waiter is taking over; the other one waits */
        }
        if (guard !== undefined) {
          fs.rmSync(lock, { force: true });
          fs.writeFileSync(lock, `${process.pid} other`);
          otherHolds = true;
          fs.closeSync(guard);
          fs.rmSync(`${lock}.takeover`, { force: true });
        }
      }
      return out;
    }) as typeof fs.readFileSync);
    cleanups.push(() => spy.mockRestore());
    expect(withLock(files.health(), () => otherHolds)).toBe(false);
  });

  it('still takes over an abandoned lock when a crash left the takeover guard behind', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    const lock = `${files.health()}.lock`;
    fs.writeFileSync(lock, '999999 deadbeef');
    fs.writeFileSync(`${lock}.takeover`, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${lock}.takeover`, old, old);
    const t0 = Date.now();
    expect(withLock(files.health(), () => fs.readFileSync(lock, 'utf8'))).not.toBe('999999 deadbeef');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fs.existsSync(`${lock}.takeover`)).toBe(false);
  });

  it('clears at once a takeover guard whose process is gone', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    // found by a review through omnitrix: a waiter killed while taking over made the next ones give up after 5 s
    const lock = `${files.health()}.lock`;
    fs.writeFileSync(lock, '999999 deadbeef');
    fs.writeFileSync(`${lock}.takeover`, '999998 deadbeef');
    const t0 = Date.now();
    withLock(files.health(), () => undefined);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(fs.existsSync(`${lock}.takeover`)).toBe(false);
  });

  it('never clears the takeover guard of a waiter that is still running, however old it is', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    // found by a review through omnitrix: a guard holder paused for over 10 s lost its guard to a second waiter,
    // and both then took over the lock
    const lock = `${files.health()}.lock`;
    const guard = `${lock}.takeover`;
    fs.writeFileSync(lock, '999999 deadbeef');
    fs.writeFileSync(guard, `${process.pid} paused`);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(guard, old, old);
    withLock(files.health(), () => undefined);
    expect(fs.readFileSync(guard, 'utf8')).toBe(`${process.pid} paused`);
    fs.rmSync(guard);
  }, 15_000);

  it('removes its lock again when writing its name into it fails', async () => {
    const { withLock, files } = await import('../src/store.js');
    fs.mkdirSync(home, { recursive: true });
    const write = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    cleanups.push(() => write.mockRestore());
    expect(() => withLock(files.health(), () => 'ran')).toThrow(/no space/);
    // a lock left behind would make the next processes wait and then go ahead together without it
    expect(fs.existsSync(`${files.health()}.lock`)).toBe(false);
    expect(withLock(files.health(), () => 'ran')).toBe('ran');
  });

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

describe('the configuration file', () => {
  it('keeps a change made while another command waits for a provider', async () => {
    const { spawnSync } = await import('node:child_process');
    const { loadConfig } = await import('../src/store.js');
    const { writeConfig } = await import('./helpers.js');
    const http = await import('node:http');
    // a provider that takes a while to list its models
    const server = http.createServer((_req, res) => {
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] })), 1500);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => server.close());
    const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
    writeConfig([account({ id: 'a', baseUrl: url, local: true, models: [makeModel('m1'), makeModel('m2')] })]);
    const cli = path.join(dist, 'cli.js');
    const env = { ...process.env, OMNITRIX_HOME: home };
    const refresh = spawn(process.execPath, [cli, 'models', 'a', '--refresh'], { env, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    // meanwhile, the account is renamed from another terminal
    expect(spawnSync(process.execPath, [cli, 'set', 'a', '--label', 'Renamed'], { env, encoding: 'utf8' }).status).toBe(0);
    await new Promise((r) => refresh.on('exit', r));
    const acc = loadConfig().accounts.find((x) => x.id === 'a')!;
    expect(acc.models.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(acc.label).toBe('Renamed');
  }, 30_000);
});

describe('the configuration file, changed by several processes', () => {
  it('loses no change when several processes change it at once', async () => {
    const { loadConfig } = await import('../src/store.js');
    const { writeConfig } = await import('./helpers.js');
    writeConfig([account({ id: 'a', models: Array.from({ length: 100 }, (_, i) => makeModel(`m${i}`)) })]);
    const url = JSON.stringify('file:///' + path.join(dist, 'store.js').split(path.sep).join('/'));
    // each process removes its own 25 models
    await inParallel(4, `const { dropModel } = await import(${url}); const p = Number(process.argv[1]); for (let i = 0; i < 25; i++) dropModel('a', 'm' + (p * 25 + i));`);
    expect(loadConfig().accounts[0]!.models).toEqual([]);
  }, 60_000);
});
