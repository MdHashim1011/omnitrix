import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_TOOLS } from '../src/drivers/cli.js';
import { chooseEffort, Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import type { TaskType } from '../src/types.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// A ChatGPT account left on "default" ran every task at Codex's own default, low effort. omnitrix now
// picks the effort from the kind of task when neither Claude nor the owner chose one.

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const codex = (over = {}) => account({ id: 'cx', provider: 'codex', driver: 'cli', models: [makeModel('default')], ...over });
const task = (type: TaskType, over = {}) => ({ title: 't', type, prompt: 'p', ...over });

describe('choosing the effort', () => {
  it('follows the kind of task on a Codex account', () => {
    const level = (type: TaskType) => chooseEffort(task(type), codex(), false);
    expect(['bulk', 'writing', 'code_snippet', 'vision'].map((t) => level(t as TaskType).effort)).toEqual(['low', 'low', 'low', 'low']);
    expect(['code', 'long_context'].map((t) => level(t as TaskType).effort)).toEqual(['medium', 'medium']);
    expect(['review', 'reasoning'].map((t) => level(t as TaskType).effort)).toEqual(['high', 'high']);
    expect(level('review').auto).toBe(true);
  });

  it('lets Claude decide first, then the owner, then omnitrix', () => {
    expect(chooseEffort(task('review', { effort: 'low' }), codex({ effort: 'medium' }), false)).toEqual({ effort: 'low', auto: false });
    expect(chooseEffort(task('review'), codex({ effort: 'medium' }), false)).toEqual({ effort: 'medium', auto: false });
    expect(chooseEffort(task('bulk'), codex(), true)).toEqual({ effort: 'high', auto: true });
  });

  it('sends nothing on its own to models that may not accept it, or when turned off', () => {
    expect(chooseEffort(task('review'), account({ id: 'k', provider: 'kimi' }), false)).toEqual({ effort: undefined, auto: false });
    expect(chooseEffort(task('review'), account({ id: 'o', provider: 'openai' }), false)).toEqual({ effort: undefined, auto: false });
    expect(chooseEffort(task('review'), account({ id: 'g', provider: 'gemini-cli', driver: 'cli' }), false)).toEqual({ effort: undefined, auto: false });
    expect(chooseEffort(task('review'), codex(), false, 'off')).toEqual({ effort: undefined, auto: false });
    // a choice someone made is still sent where they made it
    expect(chooseEffort(task('review', { effort: 'high' }), account({ id: 'o', provider: 'openai' }), false)).toEqual({ effort: 'high', auto: false });
  });
});

describe('a Codex job', () => {
  function fakeCodex(): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-effort-'));
    const script = path.join(bin, 'fake-codex.js');
    const log = path.join(bin, 'args.log');
    fs.writeFileSync(script, `const fs=require('fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
process.stdin.resume();process.stdin.on('end',()=>{
  fs.writeFileSync(args[args.indexOf('-o')+1],'fine');
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
});`);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\nnode "${script}" %*\r\n`);
    else fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    cleanups.push(() => {
      process.env.PATH = oldPath;
      // Windows may hold the folder a moment after the fake CLI exits
      try {
        fs.rmSync(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* the temp folder is left behind; nothing depends on it */
      }
    });
    return log;
  }

  it('runs at the chosen effort and records that omnitrix chose it', async () => {
    const log = fakeCodex();
    writeConfig([codex({ local: true, profileDir: path.join(home, 'profiles', 'cx') })]);
    const engine = new Engine();
    const [job] = engine.dispatch([task('reasoning')]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done).toMatchObject({ status: 'done', effort: 'high', effortAuto: true });
    expect(fs.readFileSync(log, 'utf8')).toContain('"model_reasoning_effort=high"');
    // the stronger attempt after a failed check thinks hard, whatever the kind of task
    const [again] = engine.dispatch([task('bulk')], { escalatedFrom: job!.id });
    expect((await engine.wait([again!.id], 30))[0]).toMatchObject({ status: 'done', effort: 'high', effortAuto: true });
  }, 60_000);

  it('leaves other accounts as they were', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok') }));
    cleanups.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const [job] = engine.dispatch([task('review')]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.effort).toBeUndefined();
    expect(p.calls[0]!.body.reasoning_effort).toBeUndefined();
  });
});

describe('thinking level', () => {
  it('asks an API model for the requested reasoning effort', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok') }));
    cleanups.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const [high] = engine.dispatch([{ title: 'hard', type: 'reasoning', prompt: 'q', effort: 'high' }]);
    await engine.wait([high!.id], 5);
    const [plain] = engine.dispatch([{ title: 'easy', type: 'reasoning', prompt: 'q' }]);
    await engine.wait([plain!.id], 5);
    expect(p.calls[0]!.body.reasoning_effort).toBe('high');
    // without a level the provider's own default applies, so nothing is sent
    expect(p.calls[1]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('passes the level to Codex as a config setting', () => {
    const args = CLI_TOOLS.codex!.args({ model: 'default', edit: false, cwd: '.', outFile: 'out.txt', effort: 'high' });
    const i = args.indexOf('-c');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('model_reasoning_effort=high');
    expect(CLI_TOOLS.codex!.args({ model: 'default', edit: false, cwd: '.', outFile: 'out.txt' })).not.toContain('model_reasoning_effort=high');
  });
});
