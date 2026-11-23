import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { behindNote } from '../src/mcp.js';
import { makeModel } from '../src/models.js';
import { files } from '../src/store.js';
import { account, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A fake codex that writes hello.txt. */
function fakeCodex(): void {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-rebase-'));
  const script = path.join(bin, 'fake-codex.js');
  fs.writeFileSync(script, `const fs=require('fs'),path=require('path');const args=process.argv.slice(2);let stdin='';
process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{
  const cwd=args[args.indexOf('-C')+1];
  fs.writeFileSync(path.join(cwd,'hello.txt'),'hi');
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

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-rebase-'));
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'v1');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const commit = (file: string, text: string) => {
    fs.writeFileSync(path.join(dir, file), text);
    g('add', '-A');
    g('commit', '-q', '-m', `change ${file}`);
  };
  return { dir, g, commit, head: () => g('rev-parse', 'HEAD').stdout.trim() };
}

// passes only once the code holds README v2, which reaches the job's branch only through a rebase
const needsV2 = [process.execPath, '-e', "process.exit(require('fs').readFileSync('README.md','utf8').includes('v2')?0:1)"];

async function codeJob(repo: string, test?: string[]) {
  fakeCodex();
  writeConfig([account({ id: 'cx', provider: 'codex', driver: 'cli', models: [makeModel('default')], profileDir: path.join(home, 'profiles', 'cx') })]);
  const engine = new Engine();
  const [job] = engine.dispatch([{ title: 'add hello', type: 'code', prompt: 'write hello.txt', repo, files: ['hello.txt'], ...(test ? { test } : {}) }]);
  const [done] = await engine.wait([job!.id], 30);
  expect(done!.status).toBe('done');
  return { engine, job: done! };
}

describe('a job whose repository moved on', () => {
  it('reports the newer commits, and which of its files changed there', async () => {
    const r = makeRepo();
    const { engine, job } = await codeJob(r.dir);
    expect(engine.behind(job)).toEqual({ commits: 0, files: [] });
    r.commit('README.md', 'v2');
    expect(engine.behind(job)).toEqual({ commits: 1, files: [] });
    r.commit('hello.txt', 'upstream');
    expect(engine.behind(job)).toEqual({ commits: 2, files: ['hello.txt'] });
    expect(behindNote({ commits: 2, files: ['hello.txt'] }, job.id)).toMatch(new RegExp(`2 newer commits since this job started, and hello\\.txt changed there too: run omnitrix rebase ${job.id}`));
    expect(behindNote({ commits: 1, files: [] }, job.id)).toMatch(/1 newer commit since this job started; none of this job's files changed there/);
  }, 40_000);

  it('shows on the dashboard when a job is out of date, reading git at most once in a while', async () => {
    const { behindReader, recentJobs } = await import('../src/dashboard.js');
    const r = makeRepo();
    const { engine, job } = await codeJob(r.dir);
    const row = (read: ReturnType<typeof behindReader>) => recentJobs(engine, 30, read).find((x) => x.id === job.id)!;
    expect(row(behindReader(engine, 0)).behind).toBeUndefined();
    const cached = behindReader(engine, 60_000);
    expect(row(cached).behind).toBeUndefined();
    r.commit('hello.txt', 'upstream');
    // the cached reading stands until it is old; a fresh reader sees the new commit and the job's own file
    expect(row(cached).behind).toBeUndefined();
    expect(row(behindReader(engine, 0)).behind).toEqual({ commits: 1, files: ['hello.txt'], more: 0 });
    // a rejected job will not be merged, so it is not shown as out of date
    engine.verdict(job.id, false, 'no');
    expect(row(behindReader(engine, 0)).behind).toBeUndefined();
  }, 40_000);

  it('rebases onto the current HEAD and runs the test again on the result', async () => {
    const r = makeRepo();
    const { engine, job } = await codeJob(r.dir, needsV2);
    expect(job.verify!.test!.status).toBe('failed');
    r.commit('README.md', 'v2');
    // `omnitrix rebase` runs in its own process, while the MCP server keeps the job in memory
    const out = await new Engine().rebase(job.id);
    expect(out.status).toBe('rebased');
    expect(r.g('rev-parse', `${job.worktree!.branch}~1`).stdout.trim()).toBe(r.head());
    const saved = engine.getJob(job.id)!;
    expect(saved.verify!.files).toEqual(['hello.txt']);
    expect(saved.verify!.test!.status).toBe('passed');
    expect(saved.rebased!.onto).toBe(r.head());
    expect(engine.behind(saved)).toEqual({ commits: 0, files: [] });
    // the job's checkout now holds the rebased branch
    expect(fs.readFileSync(path.join(saved.worktree!.path, 'README.md'), 'utf8')).toBe('v2');
    expect(fs.readdirSync(files.worktrees()).filter((n) => n.startsWith(`${job.id}.rebase`))).toEqual([]);
  }, 60_000);

  it('says so when there is nothing to rebase onto', async () => {
    const r = makeRepo();
    const { engine, job } = await codeJob(r.dir);
    expect((await engine.rebase(job.id)).status).toBe('up_to_date');
  }, 40_000);

  it('stops at a conflict, lists the files and changes nothing', async () => {
    const r = makeRepo();
    const { engine, job } = await codeJob(r.dir);
    const tip = r.g('rev-parse', job.worktree!.branch).stdout.trim();
    r.commit('hello.txt', 'upstream');
    const out = await engine.rebase(job.id);
    expect(out).toMatchObject({ status: 'conflict', files: ['hello.txt'] });
    expect(r.g('rev-parse', job.worktree!.branch).stdout.trim()).toBe(tip);
    expect(fs.readFileSync(path.join(job.worktree!.path, 'hello.txt'), 'utf8')).toBe('hi');
    expect(fs.readdirSync(files.worktrees()).filter((n) => n.startsWith(`${job.id}.rebase`))).toEqual([]);
    expect(r.g('status', '--porcelain').stdout.trim()).toBe('');
  }, 40_000);

  it("never runs git inside the worker's own checkout, which the worker could have changed", async () => {
    const r = makeRepo();
    const { engine, job } = await codeJob(r.dir);
    r.commit('README.md', 'v2');
    // a worker that pointed its checkout at another git folder (git hides this file on Windows, which blocks an overwrite)
    fs.rmSync(path.join(job.worktree!.path, '.git'), { force: true });
    fs.writeFileSync(path.join(job.worktree!.path, '.git'), 'gitdir: /nowhere/at/all\n');
    const out = await engine.rebase(job.id);
    expect(out.status).toBe('rebased');
    expect(r.g('rev-parse', `${job.worktree!.branch}~1`).stdout.trim()).toBe(r.head());
  }, 40_000);

  it('rebases a job again, also when its checkout kept the temporary name, and drops the old check', async () => {
    const r = makeRepo();
    const { engine, job } = await codeJob(r.dir);
    r.commit('README.md', 'v2');
    expect((await engine.rebase(job.id)).status).toBe('rebased');
    // a checkout Windows would not let go of stays under its temporary name and becomes the job's own
    const first = engine.getJob(job.id)!;
    first.check = { status: 'pass', job_id: 'jcheck0001', by: 'x/y' } as any; // the MCP server's copy
    const moved = path.join(files.worktrees(), `${job.id}.rebase-old`);
    r.g('worktree', 'move', first.worktree!.path, moved);
    const file = path.join(files.jobs(), `${job.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.worktree.path = moved;
    saved.check = { status: 'pass', job_id: 'jcheck0001', by: 'x/y' };
    saved.rebased.at = Date.now() + 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    r.commit('README.md', 'v3');
    expect((await new Engine().rebase(job.id)).status).toBe('rebased');
    const again = engine.getJob(job.id)!;
    expect(r.g('rev-parse', `${job.worktree!.branch}~1`).stdout.trim()).toBe(r.head());
    expect(fs.readFileSync(path.join(again.worktree!.path, 'hello.txt'), 'utf8')).toBe('hi');
    expect(fs.readFileSync(path.join(again.worktree!.path, 'README.md'), 'utf8')).toBe('v3');
    expect(again.check).toBeUndefined();
  }, 60_000);

  it('refuses a job file whose branch or checkout is not the one omnitrix made', async () => {
    const r = makeRepo();
    const { job } = await codeJob(r.dir);
    r.commit('README.md', 'v2');
    const file = path.join(files.jobs(), `${job.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-elsewhere-'));
    fs.writeFileSync(file, JSON.stringify({ ...saved, worktree: { ...saved.worktree, path: outside } }));
    expect(await new Engine().rebase(job.id)).toMatchObject({ status: 'not_possible', reason: expect.stringMatching(/not the one omnitrix made/) });
    expect(fs.existsSync(outside)).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ ...saved, worktree: { ...saved.worktree, branch: '--force' } }));
    expect(await new Engine().rebase(job.id)).toMatchObject({ status: 'not_possible' });
    fs.rmSync(outside, { recursive: true, force: true });
  }, 40_000);

  it('keeps a verdict that Claude gave while the rebase was running the test', async () => {
    const r = makeRepo();
    // the first run (in the worker's checkout) passes at once; after the rebase it waits for a second
    const slow = [process.execPath, '-e', "if(require('fs').readFileSync('README.md','utf8').includes('v2'))setTimeout(()=>{},3000)"];
    const { engine, job } = await codeJob(r.dir, slow);
    engine.verdict(job.id, true, 'looked fine');
    r.commit('README.md', 'v2');
    const running = new Engine().rebase(job.id);
    await new Promise((res) => setTimeout(res, 1500));
    expect(engine.verdict(job.id, false, 'second look: wrong')!.verdict).toBe('rejected');
    expect((await running).status).toBe('rebased');
    const saved = JSON.parse(fs.readFileSync(path.join(files.jobs(), `${job.id}.json`), 'utf8'));
    expect(saved.verdict).toBe('rejected');
    expect(saved.rebased).toBeDefined();
  }, 60_000);

  it('refuses jobs that cannot be rebased', async () => {
    const r = makeRepo();
    const { engine, job } = await codeJob(r.dir);
    expect(await engine.rebase('jnosuchjob1')).toMatchObject({ status: 'not_possible' });
    r.commit('README.md', 'v2');
    r.g('merge', '-q', '--no-edit', job.worktree!.branch);
    expect(engine.behind(job)).toBeUndefined();
    expect(await engine.rebase(job.id)).toMatchObject({ status: 'not_possible', reason: expect.stringMatching(/already merged/) });
  }, 40_000);

  it('omnitrix rebase prints the outcome and exits with 1 on a conflict', async () => {
    const r = makeRepo();
    const { job } = await codeJob(r.dir);
    r.commit('hello.txt', 'upstream');
    const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const res = await new Promise<{ out: string; code: number }>((resolve) =>
      execFile(process.execPath, [cli, 'rebase', job.id], { env: { ...process.env, OMNITRIX_HOME: home } }, (e, so, se) => resolve({ out: String(so) + String(se), code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 })));
    expect(res.out).toMatch(/conflict in hello\.txt; nothing was changed/);
    expect(res.code).toBe(1);
  }, 40_000);
});
