import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { files, writeJson } from '../src/store.js';
import { verifySummary } from '../src/verify.js';
import { account, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A fake codex that writes hello.txt, and extra.txt too when the prompt asks for EXTRA. */
function fakeCodex(): void {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-verify-'));
  const script = path.join(bin, 'fake-codex.js');
  fs.writeFileSync(script, `const fs=require('fs'),path=require('path');const args=process.argv.slice(2);let stdin='';
process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{
  const cwd=args[args.indexOf('-C')+1];
  fs.writeFileSync(path.join(cwd,'hello.txt'),'hi');
  if(stdin.includes('EXTRA')) fs.writeFileSync(path.join(cwd,'extra.txt'),'x');
  if(stdin.includes('MOVE')){fs.mkdirSync(path.join(cwd,'src'),{recursive:true});fs.renameSync(path.join(cwd,'secret','x.txt'),path.join(cwd,'src','x.txt'))}
  fs.writeFileSync(args[args.indexOf('-o')+1],'done');
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
});`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\nnode "${script}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  cleanups.push(() => {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });
}

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-verify-'));
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'r');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return dir;
}

function setup(settings = {}) {
  fakeCodex();
  writeConfig([account({ id: 'cx', provider: 'codex', driver: 'cli', models: [makeModel('default')], profileDir: path.join(home, 'profiles', 'cx') })], settings);
  return new Engine();
}

const node = (code: string) => [process.execPath, '-e', code];

describe('the check omnitrix makes of a code job', () => {
  it('lists the changed files and flags those the task did not name', async () => {
    const engine = setup();
    const [job] = engine.dispatch([{ title: 'add hello', type: 'code', prompt: 'write hello.txt EXTRA', repo: repo(), files: ['hello.txt'] }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.status).toBe('done');
    expect(done!.verify!.files.sort()).toEqual(['extra.txt', 'hello.txt']);
    expect(done!.verify!.outside).toEqual(['extra.txt']);
    expect(verifySummary(done!.verify!)).toMatch(/changed 2 files; 1 not named in the task: extra\.txt/);
  }, 40_000);

  it('makes no claim about scope when the task names no files', async () => {
    const engine = setup();
    const [job] = engine.dispatch([{ title: 'add hello', type: 'code', prompt: 'write hello.txt', repo: repo() }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.verify!.files).toEqual(['hello.txt']);
    expect(done!.verify!.outside).toBeUndefined();
  }, 40_000);

  it('runs the named test in the job\'s own copy and waits for it before the job counts as finished', async () => {
    const engine = setup();
    const r = repo();
    const [job] = engine.dispatch([{ title: 'add hello', type: 'code', prompt: 'write hello.txt', repo: r, test: node("process.exit(require('fs').existsSync('hello.txt')?0:1)") }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.verify!.test).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(done!.verify!.test!.durationMs).toBeGreaterThanOrEqual(0);
    // the real checkout never had the worker's file, so the test ran in the job's worktree
    expect(fs.existsSync(path.join(r, 'hello.txt'))).toBe(false);
    expect(verifySummary(done!.verify!)).toMatch(/tests passed/);
  }, 40_000);

  it('reports a failing test with its exit code and the end of its output, without keys', async () => {
    process.env.ACME_VERIFY_TOKEN = 'very-secret-value';
    cleanups.push(() => delete process.env.ACME_VERIFY_TOKEN);
    const engine = setup();
    const [job] = engine.dispatch([{ title: 'add hello', type: 'code', prompt: 'write hello.txt', repo: repo(), test: node("console.log('boom', process.env.ACME_VERIFY_TOKEN || 'no token'); process.exit(3)") }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.status).toBe('done');
    expect(done!.verify!.test).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(done!.verify!.test!.output).toContain('boom no token');
    expect(verifySummary(done!.verify!)).toMatch(/tests failed \(exit code 3, /);
  }, 40_000);

  it('stops a test that runs past the job time limit', async () => {
    const engine = setup({ jobTimeoutSec: 3 });
    const [job] = engine.dispatch([{ title: 'add hello', type: 'code', prompt: 'write hello.txt', repo: repo(), test: node('setInterval(()=>{},1000)') }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.verify!.test).toMatchObject({ status: 'error' });
    expect(done!.verify!.test!.output).toMatch(/stopped after 3 s/);
  }, 40_000);

  it.runIf(process.platform === 'win32')('starts a Windows .cmd program from a folder with spaces, with arguments passed safely', async () => {
    const { runTest } = await import('../src/verify.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix cmd dir '));
    const bat = path.join(dir, 'echo args.cmd');
    fs.writeFileSync(bat, '@echo off\r\necho first=%1 second=%2\r\nexit /b 0\r\n');
    const ok = await runTest([bat, 'a b', 'x&echo injected'], dir, 10_000);
    expect(ok.status).toBe('passed');
    expect(ok.output).toContain('first="a b" second="x&echo injected"');
    expect(ok.output).not.toMatch(/^injected/m);
    // an argument cmd.exe could still read as a command is refused, not run
    const refused = await runTest([bat, '%PATH%'], dir, 10_000);
    expect(refused.status).toBe('error');
  });

  it('says a test could not run when its program is missing, rather than that it failed', async () => {
    const { runTest } = await import('../src/verify.js');
    expect((await runTest(['no-such-program-omnitrix'], os.tmpdir(), 10_000)).status).toBe('error');
    expect((await runTest(['npm;rm', '-rf'], os.tmpdir(), 10_000)).status).toBe('error');
    // a wildcard would let the program search pick some other program, so it is not a program name
    expect((await runTest(['node*', '-e', 'process.exit(0)'], os.tmpdir(), 10_000)).status).toBe('error');
  });

  it('still reports the test when its temporary home folder cannot be removed', async () => {
    // a leftover process on Windows can hold a file there; the error must not escape the close handler
    const { runTest } = await import('../src/verify.js');
    const real = fs.rmSync;
    fs.rmSync = () => {
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    };
    try {
      const r = await runTest([process.execPath, '-e', 'process.exit(0)'], os.tmpdir(), 10_000);
      expect(r.status).toBe('passed');
    } finally {
      fs.rmSync = real;
    }
  });

  it('refuses a test command on a task that does not edit code', () => {
    const engine = setup();
    expect(() => engine.dispatch([{ title: 'r', type: 'review', prompt: 'p', test: ['npm', 'test'] }])).toThrow(/test/);
  });

  it('marks a test as interrupted when the process running it is gone', async () => {
    writeConfig([]);
    fs.mkdirSync(files.jobs(), { recursive: true });
    const id = 'jdeadtest1';
    writeJson(path.join(files.jobs(), `${id}.json`), { id, owner: '999999.dead', pid: 999999, status: 'done', createdAt: Date.now(), updatedAt: Date.now(), attempts: [], task: { title: 't', type: 'code', prompt: 'p' }, verify: { files: ['a'], test: { command: 'npm test', status: 'running' } } });
    const [j] = await new Engine().wait([id], 5);
    expect(j!.verify!.test!.status).toBe('interrupted');
  });

  it('lists both names of a moved file, so a move cannot hide a change outside the task', async () => {
    const engine = setup();
    const r = repo();
    fs.mkdirSync(path.join(r, 'secret'));
    fs.writeFileSync(path.join(r, 'secret', 'x.txt'), 'the same text in both places, long enough to count as a rename');
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: r });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'secret'], { cwd: r });
    const [job] = engine.dispatch([{ title: 'move', type: 'code', prompt: 'MOVE', repo: r, files: ['src/', 'hello.txt'] }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.verify!.outside).toEqual(['secret/x.txt']);
  }, 40_000);

  it('gives the test its own empty home folder and no passwords inside addresses', async () => {
    process.env.ACME_DB_URL = 'postgres://admin:hunter2@db.example.com/prod';
    cleanups.push(() => delete process.env.ACME_DB_URL);
    const engine = setup();
    const show = "console.log('home=' + require('os').homedir() + ' db=' + (process.env.ACME_DB_URL || 'none') + ' nocwd=' + (process.env.NoDefaultCurrentDirectoryInExePath || 'unset'))";
    const [job] = engine.dispatch([{ title: 'env', type: 'code', prompt: 'write hello.txt', repo: repo(), test: node(show) }]);
    const [done] = await engine.wait([job!.id], 30);
    const out = done!.verify!.test!.output!;
    // a fresh folder of its own, not the user's home folder
    expect(out).toMatch(/home=\S*omnitrix-test-home-/);
    expect(out).not.toMatch(new RegExp(`home=${os.homedir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\s`));
    expect(out).toContain('db=none');
    if (process.platform === 'win32') expect(out).toContain('nocwd=1');
  }, 40_000);

  it('can be cancelled while the test runs', async () => {
    const engine = setup();
    const [job] = engine.dispatch([{ title: 'slow', type: 'code', prompt: 'write hello.txt', repo: repo(), test: node('setInterval(()=>{},1000)') }]);
    await expect.poll(() => engine.getJob(job!.id)?.verify?.test?.status, { timeout: 20_000 }).toBe('running');
    expect(engine.cancel(job!.id)).toBe(true);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.verify!.test).toMatchObject({ status: 'error' });
    expect(done!.verify!.test!.output).toMatch(/cancelled/);
  }, 40_000);

  it('never hangs on an argument that cannot be passed to a program', async () => {
    const { runTest } = await import('../src/verify.js');
    expect((await runTest([process.execPath, 'a\u0000b'], os.tmpdir(), 10_000)).status).toBe('error');
    const engine = setup();
    expect(() => engine.dispatch([{ title: 'nul', type: 'code', prompt: 'p', repo: repo(), test: ['npm', 'a\u0000b'] }])).toThrow(/test/);
  }, 40_000);

  it('keeps a character whole when the test prints it in two pieces', async () => {
    const { runTest } = await import('../src/verify.js');
    // "é" is two bytes in UTF-8; the test prints them with a pause in between
    const r = await runTest(node("process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 200)"), os.tmpdir(), 10_000);
    expect(r.output).toContain('é');
  });

  it('removes terminal colour codes from the test output', async () => {
    const { runTest } = await import('../src/verify.js');
    const r = await runTest(node("console.log('\\u001b[32m✓\\u001b[39m 331 passed \\u001b[2m(212s)\\u001b[22m')"), os.tmpdir(), 10_000);
    expect(r.output).toContain('✓ 331 passed (212s)');
    expect(r.output).not.toContain('\u001b');
  });

  it('says when a job changes no files', () => {
    expect(verifySummary({ files: [], outside: [] })).toBe('changed no files');
    expect(verifySummary({ files: [] })).toBe('changed no files');
  });

  it('says when a test was stopped by a signal', () => {
    expect(verifySummary({ files: [], test: { command: 'npm test', status: 'failed', durationMs: 400 } })).toMatch(/stopped by a signal/);
    // the seconds shown and the seconds reported agree
    expect(verifySummary({ files: [], test: { command: 'npm test', status: 'passed', durationMs: 400 } })).toMatch(/npm test, 1 s/);
  });

  it.runIf(process.platform === 'win32')('runs a .cmd program whose own path contains a percent sign, without expanding it', async () => {
    const { runTest } = await import('../src/verify.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix %TEMP% '));
    const bat = path.join(dir, 'x.cmd');
    fs.writeFileSync(bat, '@echo off\r\necho ran from %~dp0\r\nexit /b 0\r\n');
    const r = await runTest([bat], dir, 10_000);
    expect(r.status).toBe('passed');
    // the folder name reached cmd.exe as text, so "%TEMP%" stayed as it is
    expect(r.output).toContain('omnitrix %TEMP% ');
  });
});
