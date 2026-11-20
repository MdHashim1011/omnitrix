import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDashboard, ping, stopDashboard } from '../src/dashboard-launch.js';
import { startDashboard } from '../src/dashboard.js';
import { Engine } from '../src/engine.js';
import { loadQuotas, saveQuotaFailure } from '../src/quota.js';
import { files, writeJson } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';
import { setSecret } from '../src/store.js';
import { VERSION } from '../src/version.js';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Reads the dashboard's live stream and keeps every snapshot it sends. */
function listen(port: number) {
  const snapshots: any[] = [];
  let alive = 0;
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith('event: alive')) alive++;
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (data && !block.startsWith('event:')) snapshots.push(JSON.parse(data.slice(6)));
      }
    });
  });
  req.on('error', () => {});
  cleanups.push(() => req.destroy());
  return { snapshots, alive: () => alive, close: () => req.destroy() };
}

async function serve() {
  const port = await freePort();
  const d = startDashboard(port);
  cleanups.push(() => d.close());
  await new Promise((r) => setTimeout(r, 100));
  return port;
}

describe('the live dashboard', () => {
  it('sends the state at once, even with nothing connected, then every change without a reload', async () => {
    writeConfig([]);
    const port = await serve();
    const live = listen(port);
    await expect.poll(() => live.snapshots.length, { timeout: 3000 }).toBe(1);
    expect(live.snapshots[0].accounts).toEqual([]);
    // an account is connected from a terminal
    writeConfig([account({ id: 'ollama', local: true, baseUrl: 'http://127.0.0.1:9/v1' })]);
    await expect.poll(() => live.snapshots.at(-1)?.accounts.map((a: any) => a.id), { timeout: 4000 }).toEqual(['ollama']);
    // a model is added, then the account is removed
    writeConfig([account({ id: 'ollama', local: true, baseUrl: 'http://127.0.0.1:9/v1', models: [] })]);
    await expect.poll(() => live.snapshots.at(-1)?.accounts[0]?.models, { timeout: 4000 }).toEqual([]);
    writeConfig([]);
    await expect.poll(() => live.snapshots.at(-1)?.accounts, { timeout: 4000 }).toEqual([]);
  }, 20_000);

  it('shows job status changes made by another omnitrix process', async () => {
    const p = await mockProvider(() => ({ json: chatReply('done'), delayMs: 1500 }));
    cleanups.push(p.close);
    setSecret('a', 'sk-test-123456789012345');
    writeConfig([account({ id: 'a', baseUrl: p.url, apiKey: 'secret' })]);
    const port = await serve();
    const live = listen(port);
    await expect.poll(() => live.snapshots.length, { timeout: 3000 }).toBeGreaterThan(0);
    const [job] = new Engine().dispatch([{ title: 'live job', type: 'review', prompt: 'p' }]);
    await expect.poll(() => live.snapshots.at(-1)?.jobs.find((j: any) => j.id === job!.id)?.status, { timeout: 4000 }).toBe('running');
    await expect.poll(() => live.snapshots.at(-1)?.jobs.find((j: any) => j.id === job!.id)?.status, { timeout: 6000 }).toBe('done');
  }, 20_000);

  it('tells the page it is still connected when nothing changes', async () => {
    writeConfig([]);
    const port = await serve();
    const live = listen(port);
    await expect.poll(() => live.alive(), { timeout: 8000, interval: 200 }).toBeGreaterThan(0);
  }, 15_000);

  it('counts open pages, so a second setup does not open another tab', async () => {
    writeConfig([]);
    const port = await serve();
    expect((await ping(port))?.viewers).toBe(0);
    const live = listen(port);
    await expect.poll(async () => (await ping(port))?.viewers, { timeout: 3000 }).toBe(1);
    live.close();
    await expect.poll(async () => (await ping(port))?.viewers, { timeout: 3000 }).toBe(0);
  }, 15_000);
});

describe('starting the dashboard', () => {
  it('starts one background server, reuses it, and opens a tab only when none is open', async () => {
    writeConfig([]);
    const port = await freePort();
    const opened: string[] = [];
    const opts = { port, cli, open: (url: string) => opened.push(url) };
    cleanups.push(() => stopDashboard(port));
    const first = await ensureDashboard(opts);
    expect(first.started).toBe(true);
    expect(opened).toEqual([`http://127.0.0.1:${port}`]);
    const pid = JSON.parse(fs.readFileSync(path.join(home, `dashboard-${port}.json`), 'utf8')).pid;
    // setup runs again before the new tab has even connected
    const again = await ensureDashboard(opts);
    expect(again.started).toBe(false);
    expect(opened).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(home, `dashboard-${port}.json`), 'utf8')).pid).toBe(pid);
    // with a tab connected, later runs do not open another one either
    const live = listen(port);
    await expect.poll(async () => (await ping(port))?.viewers, { timeout: 3000 }).toBe(1);
    await ensureDashboard(opts);
    expect(opened).toHaveLength(1);
    live.close();
  }, 30_000);

  it('a page reconnects by itself after the server restarts', async () => {
    writeConfig([]);
    const port = await freePort();
    cleanups.push(() => stopDashboard(port));
    await ensureDashboard({ port, cli, open: () => {} });
    await stopDashboard(port);
    await expect.poll(async () => (await ping(port)) === undefined, { timeout: 5000 }).toBe(true);
    await ensureDashboard({ port, cli, open: () => {} });
    expect((await ping(port))?.version).toBeDefined();
  }, 30_000);

  it('after a restart, waits for open pages to come back instead of opening another tab', async () => {
    writeConfig([]);
    const port = await freePort();
    cleanups.push(() => stopDashboard(port));
    await ensureDashboard({ port, cli, open: () => {} });
    await stopDashboard(port);
    // a page that was open reconnects a moment after the new server starts, as a browser does
    let page: ReturnType<typeof listen> | undefined;
    const reconnect = setInterval(() => {
      void ping(port).then((p) => {
        if (p && !page) page = listen(port);
      });
    }, 300);
    cleanups.push(() => clearInterval(reconnect));
    const opened: string[] = [];
    await ensureDashboard({ port, cli, open: (u) => opened.push(u) });
    expect(opened).toEqual([]);
  }, 30_000);
});

describe('a provider whose numbers cannot be refreshed', () => {
  it('keeps its last good reading, with its time, marked as stale', () => {
    fs.mkdirSync(home, { recursive: true });
    const at = Date.now() - 20 * 60_000;
    writeJson(files.quota(), { cx: { at, windows: [{ name: '5 hours', minutes: 300, usedPercent: 40, resetsAt: Date.now() + 3600_000 }] } });
    saveQuotaFailure('cx');
    const q = loadQuotas().cx!;
    expect(q.windows).toHaveLength(1);
    expect(q.at).toBe(at);
    expect(q.failedAt).toBeGreaterThan(at);
    writeConfig([account({ id: 'cx', provider: 'codex', driver: 'cli', profileDir: path.join(home, 'p') })]);
    const usage = new Engine().pool()[0]!.usage;
    expect(usage.updatedAt).toBe(at);
    expect(usage.stale).toBe(true);
    expect(usage.windows).toHaveLength(1);
  });
});

describe('after review', () => {
  /** A program on the port that answers like a dashboard of the given version, in its own process. */
  async function impostor(version: string) {
    const port = await freePort();
    const { spawn } = await import('node:child_process');
    // the program text is fixed; the version and port reach it as arguments
    const program = "const [version,port]=process.argv.slice(1);require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify(q.url==='/api/claim-open'?{open:true}:{omnitrix:true,version,pid:process.pid,viewers:0}))}).listen(Number(port),'127.0.0.1')";
    const child = spawn(process.execPath, ['-e', program, version, String(port)], { stdio: 'ignore' });
    cleanups.push(() => child.kill());
    await expect.poll(async () => (await ping(port)) !== undefined, { timeout: 5000 }).toBe(true);
    return { port, child };
  }

  it('replaces an older background dashboard when omnitrix starts after an update, and opens no tab', async () => {
    // seen in real use: a dashboard started by 0.1.26 kept running through five updates
    writeConfig([]);
    const old = await impostor('0.0.1');
    writeJson(path.join(home, `dashboard-${old.port}.json`), { pid: old.child.pid, port: old.port, version: '0.0.1' });
    cleanups.push(() => stopDashboard(old.port));
    const { refreshDashboards } = await import('../src/dashboard-launch.js');
    expect(await refreshDashboards({ cli })).toEqual([old.port]);
    expect((await ping(old.port))?.version).not.toBe('0.0.1');
  }, 30_000);

  it('leaves a newer dashboard alone, so an older omnitrix cannot turn it back', async () => {
    writeConfig([]);
    const newer = await impostor('99.0.0');
    writeJson(path.join(home, `dashboard-${newer.port}.json`), { pid: newer.child.pid, port: newer.port, version: '99.0.0' });
    // if the code is wrong it starts a real dashboard here, which must not outlive the test
    cleanups.push(() => stopDashboard(newer.port));
    const { refreshDashboards } = await import('../src/dashboard-launch.js');
    expect(await refreshDashboards({ cli })).toEqual([]);
    expect((await ping(newer.port))?.version).toBe('99.0.0');
  }, 30_000);

  it('brings back a dashboard whose process ended without being stopped, such as when Claude Code closed', async () => {
    // seen in real use: restarting Claude Code closed the dashboard it had started, and nothing restarted it
    writeConfig([]);
    const port = await freePort();
    writeJson(path.join(home, `dashboard-${port}.json`), { pid: 999999, port, version: '0.0.1' });
    cleanups.push(() => stopDashboard(port));
    const { refreshDashboards } = await import('../src/dashboard-launch.js');
    expect(await refreshDashboards({ cli })).toEqual([port]);
    expect((await ping(port))?.version).toBe(VERSION);
  }, 30_000);

  it.skipIf(process.platform !== 'win32')('starts the dashboard outside the process tree of whatever started it', async () => {
    // a program that closes its helpers closes their whole process tree on Windows, detached children included
    writeConfig([]);
    const port = await freePort();
    cleanups.push(() => stopDashboard(port));
    await ensureDashboard({ port, cli, open: false });
    const pid = (await ping(port))!.pid;
    const { execFileSync } = await import('node:child_process');
    const parent = Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8' }).trim());
    expect(parent).not.toBe(process.pid);
  }, 30_000);

  it('never stops an older dashboard that this omnitrix data folder did not start', async () => {
    // seen in real use: a run with another data folder stopped the owner's own dashboard and took its port
    writeConfig([]);
    const other = await impostor('0.0.1');
    cleanups.push(() => stopDashboard(other.port));
    await expect(ensureDashboard({ port: other.port, cli, open: false })).rejects.toThrow(/another omnitrix data folder/);
    expect((await ping(other.port))?.version).toBe('0.0.1');
  }, 30_000);

  it('still replaces an older dashboard that this data folder started', async () => {
    writeConfig([]);
    const old = await impostor('0.0.1');
    writeJson(path.join(home, `dashboard-${old.port}.json`), { pid: old.child.pid, port: old.port, version: '0.0.1' });
    cleanups.push(() => stopDashboard(old.port));
    const d = await ensureDashboard({ port: old.port, cli, open: false });
    expect(d.started).toBe(true);
    expect((await ping(old.port))?.version).not.toBe('0.0.1');
  }, 30_000);

  it('opens no tab on a program that only pretends to be the dashboard', async () => {
    writeConfig([]);
    const { VERSION } = await import('../src/version.js');
    const fake = await impostor(VERSION);
    const opened: string[] = [];
    await expect(ensureDashboard({ port: fake.port, cli, open: (u) => opened.push(u) })).rejects.toThrow(/another program/);
    expect(opened).toEqual([]);
  }, 30_000);

  it('accepts a limited number of open pages', async () => {
    writeConfig([]);
    const port = await serve();
    for (let i = 0; i < 16; i++) listen(port);
    await expect.poll(async () => (await ping(port))?.viewers, { timeout: 5000 }).toBe(16);
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
      });
    });
    expect(status).toBe(503);
  }, 20_000);

  it('tells Claude where the dashboard runs only when it really answers', async () => {
    const { runningDashboard } = await import('../src/dashboard-launch.js');
    fs.mkdirSync(home, { recursive: true });
    // a record left behind, naming a live process (this one) but a port where nothing answers
    writeJson(path.join(home, 'dashboard-4999.json'), { pid: process.pid, port: 4999, version: 'x' });
    expect(await runningDashboard()).toBeNull();
    writeConfig([]);
    const port = await freePort();
    cleanups.push(() => stopDashboard(port));
    await ensureDashboard({ port, cli, open: false });
    expect(await runningDashboard()).toBe(`http://127.0.0.1:${port}`);
  }, 30_000);
});

describe('jobs as the dashboard lists them', () => {
  it('shows a second check on the job it belongs to, not as a job of its own', async () => {
    // seen in real use: a check that found no account strong enough showed as a red "Failed" job
    const { recentJobs } = await import('../src/dashboard.js');
    const base = { owner: '999999.dead', pid: 999999, createdAt: Date.now(), updatedAt: Date.now(), attempts: [] };
    writeJson(path.join(files.jobs(), 'jparent9.json'), { ...base, id: 'jparent9', status: 'done', task: { title: 'Review', type: 'review', prompt: 'p' },
      check: { status: 'unavailable', jobId: 'jcheck99', note: 'no account can take this task. ollama/tiny: weaker at review (fit 0.30) than the worker it would check' } });
    writeJson(path.join(files.jobs(), 'jcheck99.json'), { ...base, id: 'jcheck99', status: 'failed', checkOf: 'jparent9', error: 'no account can take this task', task: { title: 'Check: Review', type: 'review', prompt: 'p' } });
    const jobs = recentJobs(new Engine());
    expect(jobs.map((j) => j.id)).toEqual(['jparent9']);
    expect(jobs[0]!.check).toEqual({ status: 'unavailable', by: undefined, note: expect.stringMatching(/weaker at review/) });
  });
});
