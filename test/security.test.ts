import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDashboard } from '../src/dashboard.js';
import { runCli } from '../src/drivers/cli.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { files, setSecret } from '../src/store.js';
import { createWorktree, pruneWorktree } from '../src/worktree.js';
import { account, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
beforeEach(() => tempHome());
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

/** A fake "codex" on PATH that records its argv and stdin to the file named by FAKE_RECORD. */
function installRecordingCodex(): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-sec-'));
  const script = path.join(bin, 'fake-codex.js');
  fs.writeFileSync(
    script,
    `const fs=require('fs');
const args=process.argv.slice(2);let stdin='';
process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{
  fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({argv:process.argv,stdin}));
  const out=args[args.indexOf('-o')+1];
  fs.writeFileSync(out,'recorded');
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
});`,
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\n"%_prog%"  "%dp0%\\fake-codex.js" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
  }
  cleanups.push(() => fs.rmSync(bin, { recursive: true, force: true }));
  return bin;
}

function usePath(bin: string) {
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  cleanups.push(() => {
    process.env.PATH = oldPath;
  });
}

describe('secrets', () => {
  it.skipIf(process.platform === 'win32')('writes secrets.json readable by the owner only', () => {
    setSecret('acct', 'sk-test-123456789012345');
    expect(fs.statSync(files.secrets()).mode & 0o777).toBe(0o600);
    // a later update keeps the restriction
    setSecret('acct2', 'sk-test-abcdefghijklmnop');
    expect(fs.statSync(files.secrets()).mode & 0o777).toBe(0o600);
  });
});

describe('worktrees', () => {
  it('removes repo-provided agent settings from the worker copy only', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-repo-'));
    cleanups.push(() => fs.rmSync(repo, { recursive: true, force: true }));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
    for (const dir of ['.claude', '.codex', '.gemini', '.qwen']) {
      fs.mkdirSync(path.join(repo, dir));
      fs.writeFileSync(path.join(repo, dir, 'settings.json'), '{"hooks":"evil"}');
    }
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{"mcpServers":{}}');
    git('add', '-A');
    expect(git('commit', '-q', '-m', 'init').status).toBe(0);

    const wt = createWorktree(repo, 'sec-job');
    cleanups.push(() => pruneWorktree(wt.path));
    expect(fs.readFileSync(path.join(wt.path, 'README.md'), 'utf8').trim()).toBe('hi');
    for (const name of ['.claude', '.mcp.json', '.codex', '.gemini', '.qwen']) {
      expect(fs.existsSync(path.join(wt.path, name)), `${name} in worktree`).toBe(false);
      expect(fs.existsSync(path.join(repo, name)), `${name} in original repo`).toBe(true);
    }
  });
});

describe('dashboard', () => {
  async function freePort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }

  function get(port: number, host: string, urlPath: string, extra: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: host, ...extra } }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('answers 403 to other host names and 200 to 127.0.0.1', async () => {
    writeConfig([]);
    // capture the server so the test can close it; startDashboard only returns the URL
    const created: http.Server[] = [];
    const real = http.createServer.bind(http);
    vi.spyOn(http, 'createServer').mockImplementation(((...a: unknown[]) => {
      const s = (real as (...x: unknown[]) => http.Server)(...a);
      created.push(s);
      return s;
    }) as typeof http.createServer);
    const port = await freePort();
    const url = startDashboard(port);
    cleanups.push(() => new Promise<void>((r) => {
      created.forEach((s) => s.closeAllConnections?.());
      created.forEach((s) => s.close());
      r();
    }));
    expect(url).toBe(`http://127.0.0.1:${port}`);
    await vi.waitFor(async () => expect((await get(port, '127.0.0.1', '/api/status')).status).toBe(200));

    const ok = await get(port, `127.0.0.1:${port}`, '/api/status');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toHaveProperty('accounts');

    for (const bad of ['evil.example.com', `evil.example.com:${port}`, '192.168.1.5', '[::1]']) {
      const r = await get(port, bad, '/api/status');
      expect(r.status, `Host ${bad}`).toBe(403);
      expect(r.body).not.toContain('accounts');
    }
    expect((await get(port, 'evil.example.com', '/')).status).toBe(403);

    // a page on another site can make the browser call the dashboard; browsers label such calls
    const cross = await get(port, '127.0.0.1', '/api/status', { 'Sec-Fetch-Site': 'cross-site' });
    expect(cross.status).toBe(403);
    expect((await get(port, '127.0.0.1', '/api/status', { 'Sec-Fetch-Site': 'same-site' })).status).toBe(403);
    expect((await get(port, '127.0.0.1', '/api/status', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await get(port, '127.0.0.1', '/', { 'Sec-Fetch-Site': 'none' })).status).toBe(200);
  });
});

describe('agent CLI arguments', () => {
  it('rejects model names with shell characters before starting any process', async () => {
    const bin = installRecordingCodex();
    usePath(bin);
    const marker = path.join(bin, 'started.json');
    process.env.FAKE_RECORD = marker;
    cleanups.push(() => {
      delete process.env.FAKE_RECORD;
    });
    const acct = account({ id: 'codex-sec', provider: 'codex', driver: 'cli', models: [makeModel('default')] });
    for (const model of ['x; rm -rf /', '$(whoami)', 'a b', 'm`id`', 'a|b', 'a&b', 'a\nb']) {
      await expect(runCli({ account: acct, model, prompt: 'hi', timeoutMs: 5000 }, false), JSON.stringify(model)).rejects.toMatchObject({
        name: 'DriverError',
        kind: 'bad_request',
      });
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('sends the prompt on standard input and never on the command line', async () => {
    const bin = installRecordingCodex();
    usePath(bin);
    const record = path.join(bin, 'record.json');
    process.env.FAKE_RECORD = record;
    cleanups.push(() => {
      delete process.env.FAKE_RECORD;
    });
    const profileDir = path.join(process.env.OMNITRIX_HOME!, 'profiles', 'codex-sec');
    fs.mkdirSync(profileDir, { recursive: true });
    writeConfig([account({ id: 'codex-sec', provider: 'codex', driver: 'cli', profileDir, models: [makeModel('default')], concurrency: 1 })]);

    const prompt = 'Summarise the quarterly zebra migration report with marker ZEBRA-7731-PLUM and also mention the lighthouse keeper.';
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'secret-ish', type: 'writing', prompt }]);
    const [done] = await engine.wait([job!.id], 30);
    expect(done!.error).toBeUndefined();
    expect(done!.status).toBe('done');

    const rec = JSON.parse(fs.readFileSync(record, 'utf8')) as { argv: string[]; stdin: string };
    expect(rec.stdin).toContain(prompt);
    for (const arg of rec.argv) {
      expect(arg).not.toContain('ZEBRA-7731-PLUM');
      expect(arg).not.toContain('lighthouse');
    }
    // the model name is the only free-form text that may appear in argv, and "-" means read stdin
    expect(rec.argv.at(-1)).toBe('-');
  }, 60_000);
});
