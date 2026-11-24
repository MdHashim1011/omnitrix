import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { jobView } from '../src/mcp.js';
import { makeModel } from '../src/models.js';
import { route, type RouteContext } from '../src/router.js';
import { defaultSettings, setSecret } from '../src/store.js';
import type { Account, TaskSpec } from '../src/types.js';
import { account, chatReply, mockProvider, tempHome, writeConfig, type MockCall } from './helpers.js';

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const skills = (n: number) => ({ coding: n, reasoning: n, writing: n, longContext: n, speed: 5, vision: 0 });
const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({ title: 'summary', type: 'writing', prompt: 'summarise the email', acceptance: 'names the deadline', check: true, escalate: true, ...over });
const asked = (c: MockCall) => JSON.stringify(c.body.messages);
const isCheck = (c: MockCall) => asked(c).includes("Check whether a worker's result");

/**
 * A free account whose answer fails the check and a paid, stronger one whose answer passes. Each also
 * checks the other's work, and passes only the strong account's answer.
 */
async function cheapAndStrong(strongAnswer = 'draft B, due Friday', cheapAnswer = 'draft A') {
  const verdict = (c: MockCall) => chatReply(asked(c).includes('due Friday') ? 'PASS\nIt names the deadline.' : 'FAIL\nIt never names the deadline.');
  const cheap = await mockProvider((c) => ({ json: isCheck(c) ? verdict(c) : chatReply(cheapAnswer) }));
  const strong = await mockProvider((c) => ({ json: isCheck(c) ? verdict(c) : chatReply(strongAnswer) }));
  cleanups.push(cheap.close, strong.close);
  writeConfig([
    account({ id: 'cheap', baseUrl: cheap.url, local: true, models: [makeModel('small', { skills: skills(8) })] }),
    account({ id: 'strong', baseUrl: strong.url, apiKey: 'secret', models: [{ ...makeModel('big', { skills: skills(9) }), inputPrice: 3, outputPrice: 15 }] }),
  ]);
  setSecret('strong', 'sk-test-123456789012345');
  return { cheap, strong };
}

describe('cheap first, then a stronger model', () => {
  it('ranks the first attempt as the cheap route does', () => {
    const paid = account({ id: 'paid', models: [{ ...makeModel('big', { skills: skills(9) }), inputPrice: 3, outputPrice: 15 }] });
    const free = account({ id: 'free', models: [makeModel('small', { skills: skills(6) })] });
    const ctx: RouteContext = { config: { version: 1, accounts: [paid, free], settings: { ...defaultSettings } }, health: {}, usage: {}, running: {}, stats: {} };
    const scores = (t: TaskSpec) => route(t, ctx).candidates.map((c) => [c.accountId, c.score.toFixed(6)]);
    expect(scores(task())).toEqual(scores(task({ escalate: undefined, route: 'cheap' })));
    expect(scores(task())[0]![0]).toBe('free');
  });

  it('sends a task whose check fails to the strongest model once, with the reason', async () => {
    const { strong } = await cheapAndStrong();
    const engine = new Engine();
    const [first] = engine.dispatch([task()]);
    // waiting for the first job also waits for the attempt that replaced it
    const [done] = await engine.wait([first!.id], 20);
    expect(done!.accountId).toBe('cheap');
    expect(done!.check).toMatchObject({ status: 'fail', note: 'It never names the deadline.' });
    const second = engine.getJob(done!.escalatedTo!)!;
    expect(second).toMatchObject({ status: 'done', accountId: 'strong', escalatedFrom: first!.id });
    expect(second.check).toMatchObject({ status: 'pass' });
    expect(second.task.escalate).toBeUndefined();
    expect(second.task.route).toBe('deep');
    const prompt = strong.calls.filter((c) => !isCheck(c)).map(asked).join('\n');
    expect(prompt).toContain('summarise the email');
    expect(prompt).toContain('It never names the deadline.');
    // the worker sees why, not the failed answer, which would only anchor it to the same mistake
    expect(prompt).not.toContain('draft A');
    // a check is advice; only Claude's own verdict counts for the router's records
    expect(done!.verdict).toBeUndefined();
  }, 30_000);

  it('does not escalate a result that passes its check', async () => {
    const { strong } = await cheapAndStrong(undefined, 'draft A, due Friday');
    const engine = new Engine();
    const [first] = engine.dispatch([task()]);
    const [done] = await engine.wait([first!.id], 20);
    expect(done).toMatchObject({ accountId: 'cheap', check: { status: 'pass' } });
    expect(done!.escalatedTo).toBeUndefined();
    // the strong account only checked; it was never asked to do the task
    expect(strong.calls.every(isCheck)).toBe(true);
  }, 30_000);

  it('escalates only once, even when the stronger answer fails too', async () => {
    await cheapAndStrong('draft C');
    const engine = new Engine();
    const [first] = engine.dispatch([task()]);
    const [done] = await engine.wait([first!.id], 20);
    const second = engine.getJob(done!.escalatedTo!)!;
    expect(second.check).toMatchObject({ status: 'fail' });
    expect(second.escalatedTo).toBeUndefined();
    expect(engine.listJobs(50).filter((j) => !j.checkOf)).toHaveLength(2);
  }, 30_000);

  it('does not escalate when the check could not decide', async () => {
    const cheap = await mockProvider((c) => ({ json: chatReply(isCheck(c) ? 'Hard to say.' : 'draft A') }));
    const strong = await mockProvider((c) => ({ json: chatReply(isCheck(c) ? 'Hard to say.' : 'draft B') }));
    cleanups.push(cheap.close, strong.close);
    writeConfig([
      account({ id: 'cheap', baseUrl: cheap.url, local: true, models: [makeModel('small', { skills: skills(8) })] }),
      account({ id: 'strong', baseUrl: strong.url, apiKey: 'secret', models: [{ ...makeModel('big', { skills: skills(9) }), inputPrice: 3, outputPrice: 15 }] }),
    ]);
    setSecret('strong', 'sk-test-123456789012345');
    const engine = new Engine();
    const [first] = engine.dispatch([task()]);
    const [done] = await engine.wait([first!.id], 20);
    expect(done!.check).toMatchObject({ status: 'unclear' });
    expect(done!.escalatedTo).toBeUndefined();
  }, 30_000);

  it('shows the escalation in get_results on both jobs', async () => {
    await cheapAndStrong();
    const engine = new Engine();
    const [first] = engine.dispatch([task()]);
    const [done] = await engine.wait([first!.id], 20);
    const view = jobView(done!, false, engine);
    expect(view.escalated_to).toBe(done!.escalatedTo);
    const second = jobView(engine.getJob(done!.escalatedTo!)!, false, engine);
    expect(second.escalated_from).toBe(first!.id);
  }, 30_000);

  it('needs something that can fail: a check, or a test for a code task', () => {
    writeConfig([account({ id: 'a' })]);
    const engine = new Engine();
    expect(() => engine.dispatch([task({ check: undefined })])).toThrow(/escalate.*needs "check"/);
    expect(() => engine.dispatch([task({ copies: 2 })])).toThrow(/escalate/);
    expect(() => engine.dispatch([task({ use: 'a' })])).toThrow(/escalate/);
    expect(() => engine.dispatch([task({ route: 'deep' })])).toThrow(/escalate/);
  });
});

describe('a code task whose test fails', () => {
  /** A fake codex that writes "good" into hello.txt only when told an earlier attempt did not pass. */
  function fakeCodex(): void {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-escalate-'));
    const script = path.join(bin, 'fake-codex.js');
    fs.writeFileSync(script, `const fs=require('fs'),path=require('path');const args=process.argv.slice(2);let stdin='';
process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{
  const cwd=args[args.indexOf('-C')+1];
  fs.writeFileSync(path.join(cwd,'hello.txt'),stdin.includes('An earlier attempt did not pass')?'good':'bad');
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-escalate-'));
    const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    fs.writeFileSync(path.join(dir, 'README.md'), 'r');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('runs the task again on another model, which is told how the test failed', async () => {
    fakeCodex();
    const models = [makeModel('small', { skills: skills(6) }), makeModel('big', { skills: skills(9) })];
    writeConfig([account({ id: 'cx', provider: 'codex', driver: 'cli', models, profileDir: path.join(home, 'profiles', 'cx') }) as Account]);
    const engine = new Engine();
    const test = [process.execPath, '-e', "const t=require('fs').readFileSync('hello.txt','utf8');if(t!=='good'){console.log('hello.txt says '+t);process.exit(3)}"];
    const [first] = engine.dispatch([{ title: 'hello', type: 'code', prompt: 'write hello.txt', repo: repo(), test, escalate: true }]);
    const [done] = await engine.wait([first!.id], 60);
    expect(done!.verify!.test).toMatchObject({ status: 'failed', exitCode: 3 });
    const second = engine.getJob(done!.escalatedTo!)!;
    expect(second.verify!.test).toMatchObject({ status: 'passed' });
    expect(second.model).not.toBe(done!.model);
    expect(second.task.prompt).toMatch(/An earlier attempt did not pass[\s\S]*exit code 3[\s\S]*hello\.txt says bad/);
  }, 90_000);
});
