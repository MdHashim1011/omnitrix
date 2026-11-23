import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_TOOLS, classifyCliError } from '../src/drivers/cli.js';
import { classifyStatus, postJson } from '../src/drivers/http.js';
import { runOpenAI } from '../src/drivers/openai.js';
import { DriverError } from '../src/types.js';
import { account } from './helpers.js';

const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

/** A local server that answers every request with the given status and body, and keeps what it was sent. */
async function serve(status: number, body: unknown, headers: Record<string, string> = {}) {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      seen.push(data ? JSON.parse(data) : null);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

const answer = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } };

describe('errors from agent CLIs', () => {
  it('does not take a file the agent could not write, or a file named login, for a sign-in problem', () => {
    expect(classifyCliError('Error: Permission denied (os error 5) while writing src/app.ts')).toBe('unknown');
    expect(classifyCliError('EACCES: permission denied, open C:\\repo\\dist\\cli.js')).toBe('unknown');
    expect(classifyCliError('test failed in src/login.test.ts')).toBe('unknown');
  });

  it('still knows a real sign-in problem', () => {
    expect(classifyCliError('Not logged in. Please run codex login')).toBe('auth');
    expect(classifyCliError('Invalid API key provided')).toBe('auth');
    expect(classifyCliError('Please run /login to sign in again')).toBe('auth');
    expect(classifyCliError('Error: insufficient permissions for this resource (403)')).toBe('auth');
  });

  it("does not count Codex's reasoning tokens twice: they are part of its output tokens", () => {
    const stdout = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 30 } });
    expect(CLI_TOOLS.codex!.parse(stdout, '/nonexistent/out.txt').outputTokens).toBe(40);
  });
});

describe('errors from APIs', () => {
  it("treats Gemini's per-minute limit as a short wait and reads the wait from the answer", async () => {
    const perMinute = {
      error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' },
        ],
      },
    };
    expect(classifyStatus(429, JSON.stringify(perMinute))).toBe('rate_limit');
    const s = await serve(429, perMinute);
    const err = await postJson(`${s.url}/chat/completions`, {}, {}, 5000).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(37_000);
  });

  it("keeps Gemini's daily limit as a used-up quota", () => {
    const perDay = '{"error":{"code":429,"message":"You exceeded your current quota. Quota exceeded for metric: x, limit: 250","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}';
    expect(classifyStatus(429, perDay)).toBe('quota');
    const both = perDay.replace('"violations":[', '"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"},');
    expect(classifyStatus(429, both)).toBe('quota');
  });

  it("knows Gemini's answer to a wrong key as a sign-in problem, not the task's", () => {
    const body = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}';
    expect(classifyStatus(400, body)).toBe('auth');
  });
});

describe('the OpenAI-format driver', () => {
  it('asks OpenAI for max_completion_tokens, which its reasoning models need, and others for max_tokens', async () => {
    const s = await serve(200, answer);
    await runOpenAI({ account: account({ id: 'oa', provider: 'openai', baseUrl: s.url, local: true }), model: 'gpt-x', prompt: 'p', timeoutMs: 5000, maxOutputTokens: 100 });
    await runOpenAI({ account: account({ id: 'gr', provider: 'groq', baseUrl: s.url, local: true }), model: 'm', prompt: 'p', timeoutMs: 5000, maxOutputTokens: 100 });
    expect(s.seen[0]).toMatchObject({ max_completion_tokens: 100 });
    expect(s.seen[0].max_tokens).toBeUndefined();
    expect(s.seen[1]).toMatchObject({ max_tokens: 100 });
  });

  it('sends nothing for a job that was cancelled before it started', async () => {
    const s = await serve(200, answer);
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await runOpenAI({ account: account({ id: 'gr', provider: 'groq', baseUrl: s.url, local: true }), model: 'm', prompt: 'p', timeoutMs: 5000, signal: ctrl.signal }).catch((e) => e);
    expect(err.kind).toBe('cancelled');
    expect(s.seen).toEqual([]);
  });
});

describe('a CLI that prints a very long output', () => {
  it('keeps the end, where the tools put their token counts', async () => {
    const { runCli } = await import('../src/drivers/cli.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-long-'));
    const script = path.join(bin, 'fake-codex.js');
    fs.writeFileSync(script, `const fs=require('fs');const a=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{
  fs.writeFileSync(a[a.indexOf('-o')+1],'done');
  const line='x'.repeat(1e6)+'\\n';let n=0;
  const more=()=>{while(n<42){n++;if(!process.stdout.write(line))return process.stdout.once('drain',more);}
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:5}}));};
  more();});`);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\nnode "${script}" %*\r\n`);
    else fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + oldPath;
    try {
      const r = await runCli({ account: account({ id: 'cx', provider: 'codex', driver: 'cli', profileDir: path.join(bin, 'profile') }), model: 'default', prompt: 'p', timeoutMs: 60_000 }, false);
      expect(r.text).toBe('done');
      expect(r.inputTokens).toBe(7);
      expect(r.outputTokens).toBe(5);
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 90_000);
});
