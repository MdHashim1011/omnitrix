import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOpenCode } from '../src/drivers/cli.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { route, type RouteContext } from '../src/router.js';
import { defaultSettings } from '../src/store.js';
import type { Config, TaskSpec } from '../src/types.js';
import { account, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * A fake opencode that records what it was given (its config, its environment and its arguments), writes
 * hello.txt in the folder it runs in and prints OpenCode's JSON events. `mode` "fail" prints an error event.
 */
function fakeOpenCode(mode: 'ok' | 'fail' = 'ok'): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-opencode-'));
  const seen = path.join(bin, 'seen.json');
  const script = path.join(bin, 'fake-opencode.js');
  fs.writeFileSync(script, `const fs=require('fs'),path=require('path');let stdin='';
process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{
  fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({args:process.argv.slice(2),config:process.env.OPENCODE_CONFIG_CONTENT,key:process.env.OMNITRIX_WORKER_KEY,parentKey:process.env.SOME_PARENT_API_KEY||null,plain:process.env.OMNITRIX_TEST_PLAIN||null,pwd:process.env.PWD||null,home:process.env.HOME,stdin,cwd:process.cwd()}));
  const ev=(o)=>console.log(JSON.stringify(o));
  if(${JSON.stringify(mode)}==='fail'){ev({type:'error',error:{name:'APIError',data:{message:'this model does not support tools',statusCode:400}}});process.exit(1);}
  fs.writeFileSync(path.join(process.cwd(),'hello.txt'),'hi');
  ev({type:'step_start',part:{type:'step-start'}});
  ev({type:'tool_use',part:{type:'tool',tool:'write',state:{status:'completed'}}});
  ev({type:'step_finish',part:{type:'step-finish',tokens:{total:1100,input:1000,output:40,reasoning:10,cache:{write:0,read:50}},cost:0.002}});
  ev({type:'text',part:{type:'text',text:'Wrote hello.txt.'}});
  ev({type:'step_finish',part:{type:'step-finish',tokens:{total:120,input:100,output:5,reasoning:0,cache:{write:0,read:15}},cost:0.001}});
});`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'opencode.cmd'), `@ECHO off\r\nnode "${script}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'opencode'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  cleanups.push(() => {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });
  return seen;
}

/** PATH without any opencode on it. */
function noOpenCode(): void {
  const oldPath = process.env.PATH;
  process.env.PATH = (oldPath ?? '').split(path.delimiter).filter((d) => !fs.existsSync(path.join(d, 'opencode')) && !fs.existsSync(path.join(d, 'opencode.cmd')) && !fs.existsSync(path.join(d, 'opencode.exe'))).join(path.delimiter);
  cleanups.push(() => {
    process.env.PATH = oldPath;
  });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-apiagent-'));
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'v1');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return dir;
}

const codeTask: TaskSpec = { title: 'add hello', type: 'code', prompt: 'write hello.txt', repo: '/somewhere' };

function ctx(cfg: Config, apiAgent: boolean): RouteContext {
  return { config: cfg, health: {}, usage: {}, running: {}, stats: {}, apiAgent };
}

describe('code tasks on an API account', () => {
  const api = account({ id: 'ds', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'env:DS_TEST_KEY', models: [makeModel('deepseek-chat')] });
  const cfg = (settings: Partial<Config['settings']> = {}): Config => ({ version: 1, accounts: [api], settings: { ...defaultSettings, ...settings } });

  it('are routed to it when OpenCode is installed, and say how to make it possible when not', () => {
    expect(route(codeTask, ctx(cfg(), true)).candidates.map((c) => c.accountId)).toEqual(['ds']);
    const off = route(codeTask, ctx(cfg(), false));
    expect(off.candidates).toEqual([]);
    expect(off.rejected[0]!.reason).toMatch(/install OpenCode/);
  });

  it('skips a model that its server reports cannot call tools', () => {
    const local = account({ id: 'ol', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', local: true, models: [makeModel('vl:3b', {}, { local: true, capabilities: ['completion', 'vision'] }), makeModel('coder:7b', {}, { local: true, capabilities: ['completion', 'tools'] })] });
    const c: Config = { version: 1, accounts: [local], settings: { ...defaultSettings } };
    const r = route(codeTask, ctx(c, true));
    expect(r.candidates.map((x) => x.model)).toEqual(['coder:7b']);
    expect(r.rejected).toEqual([expect.objectContaining({ model: 'vl:3b', reason: expect.stringMatching(/cannot call tools/) })]);
    // the same model still answers tasks that need no tools
    expect(route({ title: 'r', type: 'review', prompt: 'x' }, ctx(c, true)).candidates.map((x) => x.model)).toContain('vl:3b');
  });

  it('can be turned off in the settings', () => {
    const r = route(codeTask, ctx(cfg({ apiCodeAgent: 'off' }), true));
    expect(r.candidates).toEqual([]);
    expect(r.rejected[0]!.reason).toMatch(/apiCodeAgent/);
  });

  it('runs OpenCode in the job worktree with a config that names only this account and model', async () => {
    const seenFile = fakeOpenCode();
    process.env.DS_TEST_KEY = 'sk-test-agent-key-123456';
    process.env.SOME_PARENT_API_KEY = 'parent-secret';
    process.env.OMNITRIX_TEST_PLAIN = 'visible';
    cleanups.push(() => {
      delete process.env.DS_TEST_KEY;
      delete process.env.SOME_PARENT_API_KEY;
      delete process.env.OMNITRIX_TEST_PLAIN;
    });
    const repo = makeRepo();
    writeConfig([api]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'add hello', type: 'code', prompt: 'write hello.txt', repo, files: ['hello.txt'] }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.status).toBe('done');
    expect(done!.accountId).toBe('ds');
    expect(done!.verify!.files).toEqual(['hello.txt']);
    // the cached reads count as input; reasoning counts as output
    expect(done!.usage).toMatchObject({ inputTokens: 1000 + 50 + 100 + 15, outputTokens: 40 + 10 + 5 });
    expect(engine.readOutput(done!.id)).toContain('Wrote hello.txt.');

    const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    // macOS names its temp folders /var and /private/var, so the real paths are compared
    const real = (p: string) => fs.realpathSync(p);
    expect(real(seen.cwd)).toBe(real(done!.worktree!.path));
    // OpenCode works in the folder PWD names, so it must name the worktree, not the folder omnitrix started in
    expect(real(seen.pwd)).toBe(real(done!.worktree!.path));
    expect(seen.args).toEqual(expect.arrayContaining(['run', '--format', 'json', '--model', 'omnitrix/deepseek-chat']));
    // the key reaches the agent through its own variable only, never through the config or the parent's variables
    expect(seen.key).toBe('sk-test-agent-key-123456');
    expect(seen.parentKey).toBeNull();
    // the rest of the parent's environment (PATH and the like) is kept
    expect(seen.plain).toBe('visible');
    expect(seen.config).not.toContain('sk-test-agent-key-123456');
    const config = JSON.parse(seen.config);
    expect(config.provider.omnitrix.options).toEqual({ baseURL: 'https://api.deepseek.com/v1', apiKey: '{env:OMNITRIX_WORKER_KEY}' });
    expect(Object.keys(config.provider.omnitrix.models)).toEqual(['deepseek-chat']);
    expect(config.provider.omnitrix.npm).toBe('@ai-sdk/openai-compatible');
    // titles and summaries go to the same model, and no other provider is loaded
    expect(config.model).toBe('omnitrix/deepseek-chat');
    expect(config.small_model).toBe('omnitrix/deepseek-chat');
    expect(config.enabled_providers).toEqual(['omnitrix']);
    expect(config.share).toBe('disabled');
    expect(config.autoupdate).toBe(false);
    // a home folder of its own, so the user's own OpenCode setup (MCP servers, keys) is not loaded
    expect(real(seen.home).startsWith(real(home))).toBe(true);
    // the agent reads the files itself, so they are listed rather than pasted in
    expect(seen.stdin).toContain('## Files to look at');
  }, 40_000);

  it('passes on a failure the agent reports, with its message', async () => {
    fakeOpenCode('fail');
    process.env.DS_TEST_KEY = 'sk-test';
    cleanups.push(() => delete process.env.DS_TEST_KEY);
    const repo = makeRepo();
    writeConfig([api]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'add hello', type: 'code', prompt: 'write hello.txt', repo }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.status).toBe('failed');
    expect(done!.error).toMatch(/does not support tools/);
  }, 40_000);

  it('leaves non-code tasks on the API as before', async () => {
    const seenFile = fakeOpenCode();
    writeConfig([api]);
    const r = route({ title: 'r', type: 'review', prompt: 'look' }, ctx(cfg(), true));
    expect(r.candidates.map((c) => c.accountId)).toEqual(['ds']);
    expect(fs.existsSync(seenFile)).toBe(false);
  });

  it('is not offered when OpenCode is missing, in a real engine', async () => {
    noOpenCode();
    process.env.DS_TEST_KEY = 'sk-test';
    cleanups.push(() => delete process.env.DS_TEST_KEY);
    writeConfig([api]);
    const preview = new Engine().preview({ title: 'add hello', type: 'code', prompt: 'x', repo: makeRepo() });
    expect(preview.candidates).toEqual([]);
    expect(preview.rejected[0]!.reason).toMatch(/install OpenCode/);
  });
});

describe("reading OpenCode's JSON events", () => {
  it('adds up the tokens and cost of every step and keeps the text', () => {
    const ev = (o: unknown) => JSON.stringify(o);
    const out = [
      ev({ type: 'step_start', part: {} }),
      ev({ type: 'text', part: { type: 'text', text: 'First part.' } }),
      ev({ type: 'step_finish', part: { tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 1 } }, cost: 0.5 } }),
      'not json',
      ev({ type: 'text', part: { type: 'text', text: 'Done.' } }),
      ev({ type: 'step_finish', part: { tokens: { input: 3, output: 4 }, cost: 0.25 } }),
    ].join('\n');
    expect(parseOpenCode(out)).toEqual({ text: 'First part.\n\nDone.', inputTokens: 10 + 5 + 1 + 3, outputTokens: 2 + 1 + 4, costUsd: 0.75 });
  });

  it('reports an error event', () => {
    const out = JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'rate limit reached', statusCode: 429 } } });
    expect(parseOpenCode(out)).toMatchObject({ text: '', error: 'rate limit reached' });
    expect(parseOpenCode(JSON.stringify({ type: 'error', error: { name: 'ProviderAuthError' } })).error).toBe('ProviderAuthError');
  });

  it('keeps plain text from an older OpenCode without JSON output', () => {
    expect(parseOpenCode('Just text.\n')).toEqual({ text: 'Just text.', inputTokens: 0, outputTokens: 0 });
  });
});

