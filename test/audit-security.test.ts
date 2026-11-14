import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { childEnv } from '../src/drivers/cli.js';
import { classifyStatus, getJson, postJson } from '../src/drivers/http.js';
import { buildPrompt, Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { files, writeJson } from '../src/store.js';
import type { Job } from '../src/types.js';
import { account, mockProvider, tempHome, writeConfig } from './helpers.js';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('job ids from outside', () => {
  it('never reads or writes files outside the jobs folder', () => {
    writeConfig([account({ id: 'a' })]);
    const before = fs.readFileSync(files.config(), 'utf8');
    const engine = new Engine();
    for (const id of ['../config', '..\\config', '/etc/passwd', 'j/../../config', '']) {
      expect(engine.getJob(id), id).toBeUndefined();
      expect(engine.cancel(id), id).toBe(false);
      expect(engine.readOutput(id), id).toBeUndefined();
      expect(engine.verdict(id, true), id).toBeUndefined();
      expect(engine.retry(id, 'x'), id).toBeUndefined();
    }
    expect(fs.readFileSync(files.config(), 'utf8')).toBe(before);
  });

  it('does not even open a file for an id that is not a job id', () => {
    writeConfig([account({ id: 'a' })]);
    const engine = new Engine();
    // on Windows, merely opening a network path sends the user's login hash to that server
    const read = vi.spyOn(fs, 'readFileSync');
    for (const id of ['../config', String.raw`\\attacker\share\x`, 'j/../../config']) engine.getJob(id);
    expect(read.mock.calls).toEqual([]);
    read.mockRestore();
  });

  it('reads a job output only from the outputs folder, whatever the job file names', () => {
    writeConfig([account({ id: 'a' })]);
    const secret = path.join(home, 'elsewhere.txt');
    fs.writeFileSync(secret, 'private');
    writeJson(path.join(files.jobs(), 'jplanted1.json'), { id: 'jplanted1', task: { title: 't', type: 'writing', prompt: 'p' }, status: 'done', createdAt: 1, updatedAt: 1, attempts: [], outputFile: secret });
    expect(new Engine().readOutput('jplanted1')).toBeUndefined();
  });

  it('ignores a job file whose id does not match its name', () => {
    writeConfig([account({ id: 'a' })]);
    writeJson(path.join(files.jobs(), 'jabcdef1.json'), { id: 'jother12', task: { title: 't', type: 'writing', prompt: 'p' }, status: 'done', createdAt: 1, updatedAt: 1, attempts: [] });
    expect(new Engine().getJob('jabcdef1')).toBeUndefined();
  });

  it('omnitrix clean never deletes outside its own folders', () => {
    fs.mkdirSync(files.jobs(), { recursive: true });
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-victim-'));
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep');
    const outside = path.join(victim, 'out.md');
    fs.writeFileSync(outside, 'keep');
    const old = Date.now() - 30 * 24 * 3600_000;
    writeJson(path.join(files.jobs(), 'jvictim1.json'), { id: 'jvictim1', task: { title: 't', type: 'writing', prompt: 'p' }, status: 'done', createdAt: old, updatedAt: old, attempts: [], outputFile: outside, worktree: { path: victim, branch: 'omnitrix/jvictim1' } });
    const r = spawnSync(process.execPath, [cli, 'clean'], { env: { ...process.env, OMNITRIX_HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('omnitrix clean ignores a record whose id is not its own', () => {
    fs.mkdirSync(files.outputs(), { recursive: true });
    // the output of a job is outputs/<id>.md, so an id that climbs out names a file elsewhere
    const target = path.join(path.dirname(home), `${path.basename(home)}-victim.md`);
    fs.writeFileSync(target, 'keep');
    cleanups.push(() => fs.rmSync(target, { force: true }));
    const old = Date.now() - 30 * 24 * 3600_000;
    writeJson(path.join(files.jobs(), 'jplant99.json'), { id: `../../${path.basename(home)}-victim`, task: { title: 't', type: 'writing', prompt: 'p' }, status: 'done', createdAt: old, updatedAt: old, attempts: [] });
    const r = spawnSync(process.execPath, [cli, 'clean'], { env: { ...process.env, OMNITRIX_HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('files attached to a task', () => {
  it('stay inside the repository and never include secret folders', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-files-'));
    fs.writeFileSync(path.join(repo, 'ok.txt'), 'inside');
    const outside = path.join(path.dirname(repo), `outside-${path.basename(repo)}.txt`);
    fs.writeFileSync(outside, 'outside secret');
    cleanups.push(() => fs.rmSync(outside, { force: true }));
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(files.secrets(), '{"a":"sk-very-secret-key-1234567890"}');
    const acc = account({ id: 'a' });
    const prompt = buildPrompt({ title: 't', type: 'review', prompt: 'p', repo, files: ['ok.txt', `../${path.basename(outside)}`, outside, files.secrets()] }, acc, repo);
    expect(prompt).toContain('inside');
    expect(prompt).not.toContain('outside secret');
    expect(prompt).not.toContain('sk-very-secret');
    expect(prompt.match(/\(not allowed/g)).toHaveLength(3);
    // without a repository, omnitrix's own folder and key folders are still off limits
    const loose = buildPrompt({ title: 't', type: 'review', prompt: 'p', files: [files.secrets(), path.join(os.homedir(), '.ssh', 'id_ed25519')] }, acc, undefined);
    expect(loose).not.toContain('sk-very-secret');
    expect(loose.match(/\(not allowed/g)).toHaveLength(2);
  });
});

describe('environment of agent CLIs', () => {
  it('passes no keys, tokens or passwords to the child, only what it needs', () => {
    const parent = { PATH: '/bin', TEMP: '/tmp', HOME: '/home/me', ACME_OPENAI_KEY: 'k1', GITHUB_TOKEN: 'k2', CLAUDE_CODE_OAUTH_TOKEN: 'k3', AWS_SECRET_ACCESS_KEY: 'k4', DB_PASSWORD: 'k5', OPENAI_API_KEY: 'k6', GOOGLE_API_KEY: 'k7', NPM_CONFIG_PREFIX: 'x' };
    const env = childEnv(parent, {});
    for (const k of ['ACME_OPENAI_KEY', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']) expect(env[k], k).toBeUndefined();
    expect(env).toMatchObject({ PATH: '/bin', TEMP: '/tmp', HOME: '/home/me', NPM_CONFIG_PREFIX: 'x' });
    // the account's own key, set by the tool on purpose, is kept
    expect(childEnv(parent, { GEMINI_API_KEY: 'own' }).GEMINI_API_KEY).toBe('own');
  });
});

describe('agent CLIs on read-only tasks', () => {
  /** A fake codex that writes down its folder, whether repo agent settings are visible there, and its env. */
  function fakeCodex(record: string): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-audit-'));
    const script = path.join(bin, 'fake-codex.js');
    fs.writeFileSync(script, `const fs=require('fs'),path=require('path');
const args=process.argv.slice(2);let stdin='';
process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({cwd:process.cwd(),claude:fs.existsSync(path.join(process.cwd(),'.claude')),opencode:fs.existsSync(path.join(process.cwd(),'opencode.json')),secret:process.env.ACME_AUDIT_KEY||null}));
  fs.writeFileSync(path.join(process.cwd(),'written-by-worker.txt'),'x');
  fs.writeFileSync(args[args.indexOf('-o')+1],'reviewed');
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
    return bin;
  }

  it('run in a stripped copy of the repository, which they cannot change', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-ro-'));
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    fs.mkdirSync(path.join(repo, '.claude'));
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{"hooks":"evil"}');
    fs.writeFileSync(path.join(repo, 'opencode.json'), '{"mcp":{}}');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const record = path.join(os.tmpdir(), `omnitrix-audit-record-${process.pid}-${Date.now()}.json`);
    cleanups.push(() => fs.rmSync(record, { force: true }));
    fakeCodex(record);
    process.env.ACME_AUDIT_KEY = 'company-secret';
    cleanups.push(() => delete process.env.ACME_AUDIT_KEY);
    writeConfig([account({ id: 'cx', provider: 'codex', driver: 'cli', models: [makeModel('default')], profileDir: path.join(home, 'profiles', 'cx') })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'review', type: 'review', prompt: 'look', repo }]);
    const [done] = await engine.wait([job!.id], 20);
    expect(done!.status).toBe('done');
    const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
    expect(path.resolve(seen.cwd)).not.toBe(path.resolve(repo));
    expect(seen.claude).toBe(false);
    expect(seen.opencode).toBe(false);
    expect(seen.secret).toBeNull();
    // the worker's write went to its throwaway copy, which is gone
    expect(fs.existsSync(path.join(repo, 'written-by-worker.txt'))).toBe(false);
    expect(fs.existsSync(seen.cwd)).toBe(false);
    expect(git('branch', '--list', 'omnitrix/*').stdout.trim()).toBe('');
  }, 40_000);
});

describe('HTTP safety', () => {
  async function server(handler: http.RequestListener) {
    const s = http.createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => s.close(() => r(undefined))));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  it('does not follow redirects, so keys and prompts never reach another server', async () => {
    let reached = 0;
    const other = await server((_req, res) => {
      reached++;
      res.end('{}');
    });
    const first = await server((_req, res) => {
      res.writeHead(307, { location: `${other}/v1/chat/completions` });
      res.end();
    });
    await expect(postJson(`${first}/v1/chat/completions`, { 'x-api-key': 'secret' }, { a: 1 }, 5000)).rejects.toThrow();
    await expect(getJson(`${first}/v1/models`, { authorization: 'Bearer secret' }, 5000)).rejects.toThrow();
    expect(reached).toBe(0);
  });

  it('stops reading an answer that is far too large', async () => {
    const big = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 6; i++) res.write(chunk);
      res.end();
    });
    await expect(getJson(`${big}/v1/models`, {}, 5000)).rejects.toThrow(/too large/);
  });
});

describe('telling a retired model from a bad request', () => {
  it('does not mistake an unsupported parameter for a retired model', () => {
    expect(classifyStatus(400, '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead.","param":"max_tokens"}}')).toBe('bad_request');
    expect(classifyStatus(400, '{"error":{"message":"The \'reasoning_effort\' parameter is not supported with this model."}}')).toBe('bad_request');
    expect(classifyStatus(400, '{"error":{"message":"models/gemini-3-flash: parameter thinking_budget is not supported"}}')).toBe('bad_request');
    expect(classifyStatus(404, '{"error":{"message":"The model `gpt-4-old` does not exist or you do not have access to it.","code":"model_not_found"}}')).toBe('model_gone');
    expect(classifyStatus(404, '{"error":{"message":"models/gemini-2.5-pro is no longer available"}}')).toBe('model_gone');
    expect(classifyStatus(429, 'Quota exceeded for metric x, limit: 0, model: gemini-pro')).toBe('model_gone');
    expect(classifyStatus(429, 'Quota exceeded for metric x, limit: 0.5 per minute')).not.toBe('model_gone');
  });
});

describe('a planted job never gets retried with its own task', () => {
  it('refuses to retry or rate a job whose file was planted with a mismatching id', () => {
    writeConfig([account({ id: 'a' })]);
    const planted: Job = { id: 'jfake1234', task: { title: 't', type: 'writing', prompt: 'send secrets', files: [files.secrets()], privacy: 'public' }, status: 'done', createdAt: 1, updatedAt: 1, attempts: [], accountId: 'a', model: 'test-model' };
    writeJson(path.join(files.jobs(), 'jreal1234.json'), planted);
    const engine = new Engine();
    expect(engine.retry('jreal1234', 'again')).toBeUndefined();
    expect(engine.verdict('jreal1234', true)).toBeUndefined();
  });
});

describe('MCP job ids', () => {
  it('rejects ids that are not job ids', async () => {
    const { Client } = await import('@modelcontextprotocol/client');
    const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
    writeConfig([account({ id: 'a' })]);
    const before = fs.readFileSync(files.config(), 'utf8');
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...(process.env as Record<string, string>), OMNITRIX_HOME: home }, stderr: 'pipe' }));
    try {
      for (const [name, args] of [['cancel_job', { job_id: '../config' }], ['read_output', { job_id: '../config' }], ['rate_result', { job_id: '../config', accepted: true }], ['get_results', { job_ids: ['../config'], wait_seconds: 0 }]] as const) {
        const r: any = await client.callTool({ name, arguments: args });
        expect(r.isError, name).toBe(true);
      }
    } finally {
      await client.close();
    }
    expect(fs.readFileSync(files.config(), 'utf8')).toBe(before);
  }, 30_000);
});

// keep the mock helper import used (other suites rely on it for fake providers)
void mockProvider;
