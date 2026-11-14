import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyCliError } from '../src/drivers/cli.js';
import { buildPrompt, Engine } from '../src/engine.js';
import { files, loadHealth, saveHealth, setSecret } from '../src/store.js';
import { compactLedger, LedgerTail, readLedger } from '../src/usage.js';
import { createWorktree, finishWorktree } from '../src/worktree.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-rev-'));
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return dir;
}

describe('a code worker that tampers with its git folder', () => {
  it('cannot make omnitrix run its commands when the work is committed', () => {
    const r = repo();
    const wt = createWorktree(r, 'jtamper1');
    // the worker points its .git at a repository of its own, whose settings run a program on every git command
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-evil-'));
    spawnSync('git', ['init', '-q'], { cwd: evil });
    const marker = path.join(evil, 'ran.txt');
    const hook = path.join(evil, 'hook.cmd');
    fs.writeFileSync(hook, process.platform === 'win32' ? `@echo x > "${marker}"\r\n` : `#!/bin/sh\necho x > "${marker}"\n`, { mode: 0o755 });
    spawnSync('git', ['config', 'core.fsmonitor', hook.replace(/\\/g, '/')], { cwd: evil });
    fs.rmSync(path.join(wt.path, '.git'), { force: true });
    fs.writeFileSync(path.join(wt.path, '.git'), `gitdir: ${path.join(evil, '.git').replace(/\\/g, '/')}\n`);
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'b');
    const fin = finishWorktree(wt.path, 'work', wt.gitDir);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fin.changed).toBe(true);
    // the commit went to the job's own branch in the real repository
    expect(spawnSync('git', ['show', '--name-only', '--format=', `omnitrix/jtamper1`], { cwd: r, encoding: 'utf8' }).stdout).toContain('b.txt');
  });
});

describe('files attached to a task without a repository', () => {
  it('never include credential files, and attached text has keys hidden', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-att-'));
    const netrc = path.join(dir, '.netrc');
    fs.writeFileSync(netrc, 'machine x password hunter2hunter2');
    const env = path.join(dir, '.env.local');
    fs.writeFileSync(env, 'TOKEN=abc');
    const notes = path.join(dir, 'notes.txt');
    fs.writeFileSync(notes, 'my key is sk-abcdefghijklmnopqrstuvwx');
    const p = buildPrompt({ title: 't', type: 'review', prompt: 'p', files: [netrc, env, notes] }, account({ id: 'a' }), undefined);
    expect(p).not.toContain('hunter2');
    expect(p).not.toContain('TOKEN=abc');
    expect(p).toContain('my key is');
    expect(p).not.toContain('abcdefghijklmnopqrstuvwx');
  });
});

describe('agent CLI errors, as reviewed', () => {
  it('reads a too-long prompt as a bad request and a permissions error as a login problem', () => {
    expect(classifyCliError('maximum context length exceeded')).toBe('bad_request');
    expect(classifyCliError('error: insufficient permissions for this resource (403)')).toBe('auth');
    expect(classifyCliError('Error: insufficient permissions to read the repository')).toBe('auth');
  });
});

describe('state shared between processes', () => {
  it('a success does not clear a pause that another process saved meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = await mockProvider(() => ({ json: chatReply('ok'), delayMs: 600 }));
    cleanups.push(p.close);
    setSecret('a', 'sk-test-123456789012345');
    writeConfig([account({ id: 'a', baseUrl: p.url, apiKey: 'secret' })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'r', type: 'review', prompt: 'p' }]);
    setTimeout(() => {
      // another omnitrix process hit a rate limit on the same account
      saveHealth({ a: { state: 'cooling', until: Date.now() + 600_000, reason: 'rate limited', at: Date.now() } });
      release();
    }, 200);
    await gate;
    await engine.wait([job!.id], 10);
    expect(loadHealth().a!.state).toBe('cooling');
  });

  it('a usage reader is not fooled when another process rebuilds the ledger at the same size', () => {
    fs.mkdirSync(home, { recursive: true });
    const line = (i: number) => JSON.stringify({ ts: Date.now() - 1000 + i, accountId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: i });
    fs.writeFileSync(files.ledger(), Array.from({ length: 50 }, (_, i) => line(i) + '\n').join(''));
    const tail = new LedgerTail();
    expect(tail.read(0)).toHaveLength(50);
    // a rebuild with the same number of bytes but different records
    fs.rmSync(files.ledger());
    fs.writeFileSync(files.ledger(), Array.from({ length: 50 }, (_, i) => line(i + 100) + '\n').join(''));
    expect(tail.read(0).map((r) => r.latencyMs)).toEqual(readLedger(0).map((r) => r.latencyMs));
  });

  it('a big ledger of recent records is left alone instead of being rewritten', () => {
    fs.mkdirSync(home, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), accountId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1 });
    fs.writeFileSync(files.ledger(), `${line}\n`.repeat(200));
    const before = fs.statSync(files.ledger()).mtimeMs;
    compactLedger(1000);
    expect(fs.statSync(files.ledger()).mtimeMs).toBe(before);
    expect(readLedger(0)).toHaveLength(200);
  });
});

describe('an empty answer', () => {
  it('still records the tokens the provider charged for', async () => {
    const p = await mockProvider(() => ({ json: chatReply('', { prompt_tokens: 40, completion_tokens: 2 }) }));
    cleanups.push(p.close);
    setSecret('a', 'sk-test-123456789012345');
    writeConfig([account({ id: 'a', baseUrl: p.url, apiKey: 'secret' })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'r', type: 'review', prompt: 'p' }]);
    await engine.wait([job!.id], 10);
    expect(readLedger(0).filter((r) => r.jobId === job!.id).reduce((n, r) => n + r.inputTokens, 0)).toBe(40);
  });
});

describe('a retry saved by another process', () => {
  it('survives this process writing the same job again', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok') }));
    cleanups.push(p.close);
    for (const id of ['a', 'b']) setSecret(id, 'sk-test-123456789012345');
    writeConfig([account({ id: 'a', baseUrl: p.url, apiKey: 'secret' }), account({ id: 'b', baseUrl: p.url, apiKey: 'secret' })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'r', type: 'review', prompt: 'p' }]);
    await engine.wait([job!.id], 10);
    // another process retried it and saved retriedAs to the job file
    const file = path.join(files.jobs(), `${job!.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), retriedAs: 'jother999', verdict: 'rejected' }));
    engine.verdict(job!.id, false, 'again');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).retriedAs).toBe('jother999');
    expect(engine.retry(job!.id, 'twice')).toBeUndefined();
  });
});
