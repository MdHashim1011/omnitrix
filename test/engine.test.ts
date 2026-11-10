import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAnthropic } from '../src/drivers/anthropic.js';
import { runOpenAI } from '../src/drivers/openai.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { loadHealth, setSecret } from '../src/store.js';
import { readLedger } from '../src/usage.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

let closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  tempHome();
  closers = [];
});
afterEach(async () => {
  for (const c of closers) await c();
});

describe('drivers', () => {
  it('openai driver sends the key, parses text, tokens and rate headers', async () => {
    const p = await mockProvider(() => ({ headers: { 'x-ratelimit-remaining-requests': '99' }, json: chatReply('hi there', { prompt_tokens: 12, completion_tokens: 3 }) }));
    closers.push(p.close);
    setSecret('a', 'sk-test-123456789012345');
    const r = await runOpenAI({ account: account({ id: 'a', baseUrl: p.url, apiKey: 'secret' }), model: 'test-model', system: 'sys', prompt: 'hello', timeoutMs: 5000 });
    expect(r.text).toBe('hi there');
    expect(r.inputTokens).toBe(12);
    expect(r.outputTokens).toBe(3);
    expect(r.rate?.remainingRequests).toBe(99);
    expect(p.calls[0]!.path).toBe('/v1/chat/completions');
    expect(p.calls[0]!.headers.authorization).toBe('Bearer sk-test-123456789012345');
    expect(p.calls[0]!.body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]);
  });

  it('anthropic driver uses x-api-key and the messages format', async () => {
    const p = await mockProvider(() => ({ json: { content: [{ type: 'text', text: 'yo' }], usage: { input_tokens: 7, output_tokens: 2 } } }));
    closers.push(p.close);
    process.env.PH_TEST_KEY = 'key-abc-1234567890';
    const r = await runAnthropic({ account: account({ id: 'b', driver: 'anthropic', baseUrl: p.root + '/anthropic', apiKey: 'env:PH_TEST_KEY' }), model: 'm', prompt: 'q', timeoutMs: 5000 });
    expect(r.text).toBe('yo');
    expect(p.calls[0]!.path).toBe('/anthropic/v1/messages');
    expect(p.calls[0]!.headers['x-api-key']).toBe('key-abc-1234567890');
    expect(p.calls[0]!.body.max_tokens).toBeGreaterThan(0);
  });

  it('times out slow providers', async () => {
    const p = await mockProvider(() => ({ json: chatReply('late'), delayMs: 1500 }));
    closers.push(p.close);
    await expect(runOpenAI({ account: account({ id: 'a', baseUrl: p.url, local: true }), model: 'm', prompt: 'x', timeoutMs: 200 })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('engine', () => {
  it('runs tasks in parallel and records usage', async () => {
    const p = await mockProvider((call) => ({ json: chatReply(`answer to ${call.body.messages.at(-1).content.split('\n')[2]}`), delayMs: 300 }));
    closers.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true, concurrency: 3 })]);
    const engine = new Engine();
    const t0 = Date.now();
    const jobs = engine.dispatch([1, 2, 3].map((n) => ({ title: `t${n}`, type: 'writing' as const, prompt: `q${n}` })));
    const done = await engine.wait(jobs.map((j) => j.id), 10);
    expect(done.map((j) => j.status)).toEqual(['done', 'done', 'done']);
    expect(Date.now() - t0).toBeLessThan(850); // parallel, not 3 x 300ms one after another
    expect(engine.readOutput(done[1]!.id)).toBe('answer to q2');
    expect(readLedger().filter((r) => r.ok)).toHaveLength(3);
  });

  it('falls back to the next account on a rate limit and cools the first one down', async () => {
    const limited = await mockProvider(() => ({ status: 429, headers: { 'retry-after': '30' }, json: { error: { message: 'Rate limit reached' } } }));
    const healthy = await mockProvider(() => ({ json: chatReply('from backup') }));
    closers.push(limited.close, healthy.close);
    writeConfig([
      account({ id: 'main', baseUrl: limited.url, local: true, models: [makeModel('big-pro-max')] }),
      account({ id: 'backup', baseUrl: healthy.url, local: true, models: [makeModel('small-mini')] }),
    ]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('done');
    expect(done!.accountId).toBe('backup');
    expect(done!.attempts.map((a) => `${a.accountId}:${a.errorKind ?? 'ok'}`)).toEqual(['main:rate_limit', 'backup:ok']);
    const h = loadHealth().main!;
    expect(h.state).toBe('cooling');
    expect(h.until! - Date.now()).toBeGreaterThan(25_000);
  });

  it('marks quota and login problems and fails cleanly when nobody is left', async () => {
    const broke = await mockProvider(() => ({ status: 402, json: { error: 'Insufficient balance' } }));
    const badKey = await mockProvider(() => ({ status: 401, json: { error: 'invalid key' } }));
    closers.push(broke.close, badKey.close);
    writeConfig([account({ id: 'broke', baseUrl: broke.url, local: true }), account({ id: 'badkey', baseUrl: badKey.url, local: true })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(done!.error).toMatch(/HTTP 40[12]/);
    const h = loadHealth();
    expect(h.broke!.state).toBe('exhausted');
    expect(h.badkey!.state).toBe('auth_error');
  });

  it('explains why a task cannot be placed', async () => {
    writeConfig([account({ id: 'cloud' })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q', privacy: 'secret' }]);
    const [done] = await engine.wait([job!.id], 2);
    expect(done!.status).toBe('failed');
    expect(done!.error).toMatch(/local models only/);
  });

  it('queues work when the account is busy and runs it after', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok'), delayMs: 200 }));
    closers.push(p.close);
    writeConfig([account({ id: 'one', baseUrl: p.url, local: true, concurrency: 1 })]);
    const engine = new Engine();
    const jobs = engine.dispatch([{ title: 'a', type: 'bulk', prompt: 'a' }, { title: 'b', type: 'bulk', prompt: 'b' }]);
    expect(engine.getJob(jobs[1]!.id)!.status).toBe('queued');
    const done = await engine.wait(jobs.map((j) => j.id), 10);
    expect(done.every((j) => j.status === 'done')).toBe(true);
  });

  it('records verdicts and can cancel', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok'), delayMs: 2000 }));
    closers.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true, concurrency: 1 })]);
    const engine = new Engine();
    const [slow] = engine.dispatch([{ title: 'slow', type: 'bulk', prompt: 'x' }]);
    expect(engine.cancel(slow!.id)).toBe(true);
    const [c] = await engine.wait([slow!.id], 5);
    expect(c!.status).toBe('cancelled');
    expect(engine.verdict(slow!.id, true)).toBeUndefined();
  });

  it('marks jobs from a crashed process as interrupted', async () => {
    writeConfig([account({ id: 'a' })]);
    const first = new Engine();
    const [job] = first.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    // simulate a crash: write the job as running and start a new process
    const { files, writeJson } = await import('../src/store.js');
    writeJson(path.join(files.jobs(), `${job!.id}.json`), { ...first.getJob(job!.id), status: 'running', updatedAt: Date.now(), pid: 2_000_000_000 });
    const second = new Engine();
    expect(second.getJob(job!.id)!.status).toBe('failed');
    expect(second.getJob(job!.id)!.error).toMatch(/interrupted/);
  });

  it('picks up a fix saved by another process, like "omnitrix set --key"', async () => {
    const { saveHealth } = await import('../src/store.js');
    writeConfig([account({ id: 'a', local: true })]);
    saveHealth({ a: { state: 'auth_error', reason: 'bad key', at: Date.now() - 5000 } });
    const server = new Engine();
    expect(server.pool()[0]!.state).toBe('auth_error');
    saveHealth({ a: { state: 'ready' } }); // what the CLI writes after a new key
    expect(server.pool()[0]!.state).toBe('ready');
  });

  it('refuses code tasks without a repo before queuing anything', () => {
    writeConfig([account({ id: 'a', local: true })]);
    const engine = new Engine();
    expect(() => engine.dispatch([{ title: 'ok', type: 'bulk', prompt: 'x' }, { title: 'edit', type: 'code', prompt: 'y' }])).toThrow(/need "repo"/);
    expect(engine.listJobs()).toHaveLength(0);
  });

  it('leaves jobs of another live process alone (dashboard, list, a second server)', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok'), delayMs: 1500 }));
    closers.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true, concurrency: 1 })]);
    const server = new Engine();
    const [running, waiting] = server.dispatch([
      { title: 'first', type: 'bulk', prompt: 'x' },
      { title: 'second', type: 'bulk', prompt: 'y' },
    ]);
    // a dashboard or "omnitrix list" starting up while the server works
    const viewer = new Engine();
    expect(viewer.getJob(running!.id)!.status).toBe('running');
    expect(viewer.getJob(waiting!.id)!.status).toBe('queued');
    viewer.pool();
    const done = await server.wait([running!.id, waiting!.id], 10);
    expect(done.map((j) => j.status)).toEqual(['done', 'done']);
    // the queued job ran once, on the server, not a second time from the viewer
    expect(p.calls).toHaveLength(2);
  });
});

/** A fake "codex" CLI: reads the prompt on stdin, edits a file in its working folder, writes the -o file, prints JSONL. */
function installFakeCodex(): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-'));
  const script = path.join(bin, 'fake-codex.js');
  fs.writeFileSync(
    script,
    `const fs=require('fs');const path=require('path');
const args=process.argv.slice(2);let stdin='';
process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{
  const cwd=args[args.indexOf('-C')+1];const out=args[args.indexOf('-o')+1];
  if(!process.env.CODEX_HOME){console.error('no CODEX_HOME');process.exit(2)}
  if(args.includes('--approve-for-me')) fs.writeFileSync(path.join(cwd,'hello.txt'),'written by worker\\n');
  fs.writeFileSync(out, stdin.includes('QUIET') ? '' : 'did it. home='+path.basename(process.env.CODEX_HOME)+' prompt_has_task='+stdin.includes('# Task:'));
  console.log(JSON.stringify({type:'thread.started'}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}));
});`,
  );
  if (process.platform === 'win32') {
    // same layout npm uses, so resolveCommand() finds the script inside
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\n"%_prog%"  "%dp0%\\fake-codex.js" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
  }
  return bin;
}

describe('agent CLI accounts and code tasks', () => {
  it('runs a code task in its own worktree and branch', async () => {
    const bin = installFakeCodex();
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    try {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-repo-'));
      const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
      git('init', '-q');
      git('config', 'user.email', 't@example.com');
      git('config', 'user.name', 'Test');
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
      fs.mkdirSync(path.join(repo, '.claude'));
      fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');

      const profileDir = path.join(process.env.OMNITRIX_HOME!, 'profiles', 'codex-main');
      fs.mkdirSync(profileDir, { recursive: true });
      writeConfig([account({ id: 'codex-main', provider: 'codex', driver: 'cli', profileDir, models: [makeModel('default')], concurrency: 1 })]);
      const engine = new Engine();
      const [job] = engine.dispatch([{ title: 'Add hello file', type: 'code', prompt: 'create hello.txt', repo }]);
      const [done] = await engine.wait([job!.id], 30);
      expect(done!.error).toBeUndefined();
      expect(done!.status).toBe('done');
      expect(done!.worktree!.branch).toBe(`omnitrix/${job!.id}`);
      expect(done!.worktree!.diffStat).toMatch(/hello\.txt/);
      expect(done!.worktree!.diffStat).not.toMatch(/\.claude/);
      expect(engine.readOutput(job!.id)).toMatch(/home=codex-main prompt_has_task=true/);
      expect(done!.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: undefined });
      // the main checkout is untouched; the change lives on the branch
      expect(fs.existsSync(path.join(repo, 'hello.txt'))).toBe(false);
      expect(git('show', `omnitrix/${job!.id}:hello.txt`).stdout).toBe('written by worker\n');
      expect(git('log', '-1', '--format=%an', `omnitrix/${job!.id}`).stdout.trim()).toBe('Test');

      // cleaning up removes the checkout but keeps the branch, so the work can still be merged
      const { pruneWorktree } = await import('../src/worktree.js');
      expect(pruneWorktree(done!.worktree!.path)).toBe(true);
      expect(fs.existsSync(done!.worktree!.path)).toBe(false);
      expect(git('branch', '--list', `omnitrix/${job!.id}`).stdout).toMatch(job!.id);
      expect(git('worktree', 'list').stdout).not.toMatch(job!.id);

      // real Codex sometimes edits files and ends without a closing message; that still counts as done
      const [quiet] = engine.dispatch([{ title: 'Quiet edit', type: 'code', prompt: 'QUIET create hello.txt', repo }]);
      const [quietDone] = await engine.wait([quiet!.id], 30);
      expect(quietDone!.status).toBe('done');
      expect(quietDone!.worktree!.diffStat).toMatch(/hello\.txt/);
    } finally {
      process.env.PATH = oldPath;
    }
  }, 60_000);
});
