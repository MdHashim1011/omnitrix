// A small local web page with the same numbers as `omnitrix list`. One live stream sends every change to
// every open page, so nobody has to reload it.
import fs from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Engine } from './engine.js';
import { refreshQuotas } from './quota.js';
import { ensureHome, files, homeDir, readJson, writeJson } from './store.js';
import type { Job } from './types.js';
import type { PoolAccountView } from './engine.js';
import { verifySummary } from './verify.js';
import { ICON_SVG } from './icon.js';
import { leadOut, loadLeadQuota } from './lead.js';
import { claudeProjectsDir, measureOverhead, resultTokens, type Overhead } from './overhead.js';
import { VERSION } from './version.js';
import { installedVersion } from './installed.js';

type Behind = { commits: number; files: string[] };

/**
 * How far the repository moved past each finished code job, read with git at most once per `ttlMs` for each
 * job, because the page is rebuilt every second. Rejected jobs are left out: nobody will merge them.
 */
export function behindReader(engine: Engine, ttlMs = 30_000): (j: Job) => Behind | undefined {
  return gitReader((j) => engine.behind(j), ttlMs);
}

type SinceCheck = { branchMoved: boolean; uncommitted: string[] };

/** Whether each finished code job's branch or checkout changed after omnitrix checked it, read like behindReader. */
export function sinceCheckReader(engine: Engine, ttlMs = 30_000): (j: Job) => SinceCheck | undefined {
  return gitReader((j) => engine.changedSinceCheck(j), ttlMs);
}

function gitReader<T>(read: (j: Job) => T | undefined, ttlMs: number): (j: Job) => T | undefined {
  const cache = new Map<string, { at: number; value: T | undefined }>();
  return (j) => {
    if (j.status !== 'done' || !j.worktree || !j.task.repo || j.verdict === 'rejected') return undefined;
    const hit = cache.get(j.id);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    let value: T | undefined;
    try {
      value = read(j);
    } catch {
      value = undefined;
    }
    cache.set(j.id, { at: Date.now(), value });
    // jobs fall off the page; their readings go too
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return value;
  };
}

export interface OverheadFigures {
  calls: number;
  outputTokens: number;
  resultTokens: number;
}

/**
 * Claude's own work on omnitrix over the last 7 days, for the page. Reading the session files takes seconds,
 * so it runs in the background at most once per `ttlMs`, one run at a time, and the page shows the last figures.
 */
export function overheadReader(ttlMs = 10 * 60_000, measure: (dir: string, since: number) => Promise<Overhead> = measureOverhead, clock = Date.now): () => OverheadFigures | undefined {
  let value: OverheadFigures | undefined;
  let startedAt = -Infinity;
  let running = false;
  return () => {
    const now = clock();
    if (!running && now - startedAt >= ttlMs) {
      running = true;
      startedAt = now;
      measure(claudeProjectsDir(), now - 7 * 24 * 3600_000)
        .then((o) => {
          value = o.calls ? { calls: o.calls, outputTokens: o.outputTokens, resultTokens: resultTokens(o) } : undefined;
        })
        .catch(() => {
          // keep the last figures; the next period tries again
        })
        .finally(() => {
          running = false;
        });
    }
    return value;
  };
}

/** The newest jobs for the page. A second check is shown on the job it checks, not as a job of its own. */
export function recentJobs(engine: Engine, limit = 30, behindOf?: (j: Job) => Behind | undefined, sinceOf?: (j: Job) => SinceCheck | undefined): Record<string, unknown>[] {
  const jobs = engine.listJobs(limit * 2).filter((j) => !j.checkOf && !j.hidden).slice(0, limit);
  const spend = engine.jobSpend(jobs);
  return jobs.map((j) => ({
    id: j.id,
    status: j.status,
    accountId: j.accountId,
    model: j.model,
    effort: j.effort,
    effortAuto: j.effortAuto,
    // every attempt of the job and its check, as the account's own totals count them
    spent: spend.get(j.id),
    escalatedTo: j.escalatedTo,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    verdict: j.verdict,
    error: j.error?.slice(0, 200),
    usage: j.usage,
    task: { title: j.task.title, type: j.task.type } as Job['task'],
    // omnitrix's own check of a code job, as one line; a failed test or files outside the task stand out
    verify: j.verify ? { summary: verifySummary(j.verify), warn: !!j.verify.outside?.length || (!!j.verify.test && j.verify.test.status !== 'passed' && j.verify.test.status !== 'running') } : undefined,
    check: j.check ? { status: j.check.status, by: j.check.by, note: j.check.note?.slice(0, 400) } : undefined,
    behind: moved(behindOf?.(j)),
    sinceCheck: changed(sinceOf?.(j)),
    rebased: !!j.rebased,
  }));
}

function moved(b: Behind | undefined): { commits: number; files: string[]; more: number } | undefined {
  if (!b?.commits) return undefined;
  return { commits: b.commits, files: b.files.slice(0, 5), more: Math.max(0, b.files.length - 5) };
}

function changed(s: SinceCheck | undefined): { branchMoved: boolean; files: string[]; more: number } | undefined {
  if (!s || (!s.branchMoved && !s.uncommitted.length)) return undefined;
  return { branchMoved: s.branchMoved, files: s.uncommitted.slice(0, 5), more: Math.max(0, s.uncommitted.length - 5) };
}

/** Where the dashboard on a port writes its process id, so it can be found, checked and stopped. */
export function dashboardFile(port: number): string {
  return path.join(homeDir(), `dashboard-${port}.json`);
}

// How often the stream looks for changes, how often slow provider checks may start, and how often an
// unchanged page hears that the server is still there.
const LOOK_MS = 1000;
const SLOW_MS = 5000;
const ALIVE_MS = 5000;
// After a tab is opened, it takes a moment to connect; a second setup in that time must not open another.
const OPEN_GRACE_MS = 20_000;
// More pages than anyone keeps open; a program opening streams without end is turned away.
const MAX_VIEWERS = 16;
// A page that stops reading is dropped before its unsent updates pile up.
const MAX_BUFFERED = 1024 * 1024;

/** The order the owner dragged the account cards into. It changes only the page, never which account gets work. */
export function loadCardOrder(): string[] {
  const saved = readJson<{ order?: unknown } | null>(files.dashboard(), null);
  return Array.isArray(saved?.order) ? saved.order.filter((x): x is string => typeof x === 'string') : [];
}

/** Saves the ids it knows, each once, in the order given; returns what it saved. */
export function saveCardOrder(order: unknown, known: string[]): string[] | undefined {
  if (!Array.isArray(order) || order.length > 1000) return undefined;
  const ids = [...new Set(order.filter((x): x is string => typeof x === 'string' && known.includes(x)))];
  writeJson(files.dashboard(), { order: ids });
  return ids;
}

/** The accounts in the saved order; those not in it, such as one added since, follow in the order of the config. */
export function inCardOrder<T extends Pick<PoolAccountView, 'id'>>(accounts: T[], order: string[]): T[] {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return accounts.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a.id) - rank(y.a.id) || x.i - y.i).map((x) => x.a);
}

export function startDashboard(port: number): { url: string; server: http.Server; close: () => Promise<void> } {
  const engine = new Engine();
  const viewers = new Set<http.ServerResponse>();
  let latest = '';
  let slowAt = 0;
  let openedAt = 0;
  // a page that cannot hold a live stream asks for the state every few seconds; it is an open page too
  let polledAt = 0;
  const pages = () => viewers.size + (Date.now() - polledAt < 10_000 ? 1 : 0);
  // a new token every start, so a page from before a restart has to load again to act
  const token = randomBytes(16).toString('hex');
  const page = PAGE.replace('__TOKEN__', token);

  const behindOf = behindReader(engine);
  const sinceOf = sinceCheckReader(engine);
  const overheadOf = overheadReader();
  const state = () => {
    const order = loadCardOrder();
    return { version: VERSION, installed: installedVersion(), order, accounts: inCardOrder(engine.pool(), order) };
  };
  const snapshot = (): string => JSON.stringify({ ...state(), jobs: recentJobs(engine, 30, behindOf, sinceOf), delegated: engine.delegated(7), overhead: overheadOf(), lead: leadOut(loadLeadQuota()) });
  // Quota reads and local server probes run in the background and are throttled; the page never waits for them.
  const slowChecks = () => {
    if (Date.now() - slowAt < SLOW_MS) return;
    slowAt = Date.now();
    void refreshQuotas(engine.config().accounts);
    engine.checkLocal().catch(() => {});
  };
  const send = (res: http.ServerResponse, text: string) => {
    try {
      res.write(text);
      if (res.writableLength > MAX_BUFFERED) throw new Error('not reading');
    } catch {
      viewers.delete(res);
      res.destroy();
    }
  };
  // One reading for all open pages; nothing is read while no page is open.
  const look = () => {
    if (!viewers.size) return;
    slowChecks();
    let body: string;
    try {
      body = snapshot();
    } catch {
      return; // a file half-written by another process; the next look reads it whole
    }
    if (body === latest) return;
    latest = body;
    for (const res of viewers) send(res, `data: ${body}\n\n`);
  };
  const lookTimer = setInterval(look, LOOK_MS);
  const aliveTimer = setInterval(() => {
    for (const res of viewers) send(res, `event: alive\ndata: ${Date.now()}\n\n`);
  }, ALIVE_MS);
  lookTimer.unref();
  aliveTimer.unref();

  const json = (res: http.ServerResponse, value: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(value));
  };

  const server = http.createServer((req, res) => {
    // only answer requests made to this machine by name (blocks DNS-rebinding tricks)
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403).end('forbidden');
      return;
    }
    // Any website can make the browser call this server, and each status call starts a quota read.
    // Browsers label such calls; only our own page, a typed address or a tool that sends no label gets in.
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (req.url === '/api/events') {
      if (viewers.size >= MAX_VIEWERS) {
        res.writeHead(503, { 'retry-after': '10' }).end('too many open pages');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'keep-alive' });
      // a page that loses the stream asks again after two seconds
      res.write('retry: 2000\n\n');
      if (!viewers.size || !latest) {
        try {
          latest = snapshot();
        } catch {
          latest = latest || '';
        }
      }
      if (latest) res.write(`data: ${latest}\n\n`);
      viewers.add(res);
      slowChecks();
      res.on('close', () => viewers.delete(res));
      return;
    }
    if (req.url === '/api/status') {
      polledAt = Date.now();
      slowChecks();
      json(res, { ...state(), now: Date.now(), jobs: recentJobs(engine, 30, behindOf, sinceOf), delegated: engine.delegated(7), overhead: overheadOf(), lead: leadOut(loadLeadQuota()) });
      return;
    }
    // The page's two actions: removing finished jobs from its list, and keeping the order the owner dragged the
    // account cards into. Only the page this server sent knows the token, and a browser sends a custom header
    // to another site only after asking it.
    if (req.url === '/api/hide' || req.url === '/api/order') {
      if (req.method !== 'POST' || req.headers['x-omnitrix-token'] !== token || !String(req.headers['content-type']).startsWith('application/json')) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const url = req.url;
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 16_384) req.destroy();
      });
      req.on('end', () => {
        let ask: { ids?: unknown; failed?: unknown; order?: unknown } | null;
        try {
          ask = JSON.parse(body);
        } catch {
          ask = null;
        }
        if (!ask || typeof ask !== 'object') {
          res.writeHead(400).end('bad request');
          return;
        }
        let answer: unknown;
        if (url === '/api/order') {
          const order = saveCardOrder(ask.order, engine.config().accounts.map((a) => a.id));
          if (!order) {
            res.writeHead(400).end('bad request');
            return;
          }
          answer = { order };
        } else {
          const ids = Array.isArray(ask.ids) ? ask.ids.filter((x): x is string => typeof x === 'string').slice(0, 100) : undefined;
          answer = { hidden: engine.hideJobs(ask.failed === true ? { failed: true } : { ids }) };
        }
        latest = '';
        look();
        json(res, answer);
      });
      return;
    }
    if (req.url === '/api/ping') {
      json(res, { omnitrix: true, version: VERSION, pid: process.pid, viewers: pages() });
      return;
    }
    // asked by `omnitrix dashboard` and `omnitrix init` before they open a tab: one tab is enough
    if (req.url === '/api/claim-open') {
      const open = pages() === 0 && Date.now() - openedAt > OPEN_GRACE_MS;
      if (open) openedAt = Date.now();
      json(res, { open });
      return;
    }
    if (req.url === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' }).end(ICON_SVG);
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' }).end(page);
      return;
    }
    res.writeHead(404).end('not found');
  });
  // a client that never finishes sending its request is cut off; the live stream itself has no time limit
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.listen(port, '127.0.0.1');
  const close = () => new Promise<void>((resolve) => {
    clearInterval(lookTimer);
    clearInterval(aliveTimer);
    for (const res of viewers) res.end();
    viewers.clear();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  return { url: `http://127.0.0.1:${port}`, server, close };
}

/** Run the dashboard until the process is stopped, recording where it runs. */
export function serveDashboard(port: number): void {
  const d = startDashboard(port);
  d.server.on('error', (err: NodeJS.ErrnoException) => {
    process.stderr.write(err.code === 'EADDRINUSE' ? `port ${port} is already in use\n` : `dashboard: ${err.message}\n`);
    process.exit(1);
  });
  d.server.on('listening', () => {
    try {
      ensureHome();
      writeJson(dashboardFile(port), { pid: process.pid, port, version: VERSION, startedAt: Date.now() });
    } catch {
      // the dashboard works without it; `omnitrix dashboard --stop` then cannot find it
    }
    console.log(`dashboard: ${d.url}`);
  });
  const done = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(dashboardFile(port), 'utf8'));
      if (saved.pid === process.pid) fs.rmSync(dashboardFile(port), { force: true });
    } catch {
      // nothing recorded
    }
  };
  process.on('exit', done);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
}

// The page is one self-contained file: no fonts, scripts or images from other hosts, so it works offline
// and sends nothing anywhere. The script below avoids backticks and backslashes because it lives in a
// template literal.
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="omnitrix-token" content="__TOKEN__">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omnitrix</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{
  --bg:#f6f6f3;--surface:#ffffff;--tile:#efeee9;--line:rgba(20,20,19,.11);--line-strong:rgba(20,20,19,.2);
  --ink:#141413;--ink-2:#4d4c48;--ink-3:#66655f;
  --accent:#2563c9;--accent-bg:#e6eefb;--track:#e7e6e0;
  --ok:#1b6f35;--ok-bg:#e3f2e7;--warn:#8a5a00;--warn-bg:#fbf0d4;--bad:#b42323;--bad-bg:#fbe7e7;--idle:#55544f;--idle-bg:#ecebe6;
  --focus:#2563c9;--r:12px;--r-sm:8px;
  --font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#181816;--surface:#21211f;--tile:#2a2a27;--line:rgba(255,255,255,.1);--line-strong:rgba(255,255,255,.2);
  --ink:#f0efea;--ink-2:#c9c8bf;--ink-3:#a3a299;
  --accent:#6ea3f2;--accent-bg:#1d2d45;--track:#34342f;
  --ok:#6fcf8b;--ok-bg:#16301f;--warn:#e9bf5c;--warn-bg:#382c0e;--bad:#f28b8b;--bad-bg:#3b1c1c;--idle:#bdbcb3;--idle-bg:#2f2f2b;
  --focus:#6ea3f2;color-scheme:dark;
}}
*{box-sizing:border-box}
html{scroll-padding-top:72px}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
.wrap{max-width:1180px;margin:0 auto;padding:10px 24px 48px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 -24px 20px;padding:14px 24px;position:sticky;top:0;z-index:5;background:var(--bg)}
@supports (background:color-mix(in srgb,red 50%,transparent)){header{background:color-mix(in srgb,var(--bg) 88%,transparent);-webkit-backdrop-filter:blur(18px) saturate(140%);backdrop-filter:blur(18px) saturate(140%)}}
.brand{display:flex;align-items:center;gap:10px}
.brand h1{font-size:20px;font-weight:600;margin:0;line-height:1.2;letter-spacing:-.015em}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;line-height:1;padding:5px 9px;border-radius:999px;background:var(--tile);color:var(--ink-2);white-space:nowrap}
.fresh{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-2)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
.fresh.stale .dot{background:var(--warn)}.fresh.stale{color:var(--warn)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:28px}
.kpi{background:var(--tile);border-radius:var(--r);padding:14px 16px}
.kpi span{display:block;font-size:13px;color:var(--ink-2)}
.kpi b{display:block;font-size:26px;font-weight:600;line-height:1.15;margin-top:4px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
h2{font-size:15px;font-weight:600;margin:0 0 12px;letter-spacing:-.005em;display:flex;align-items:baseline;gap:8px}
h2 small{font-size:13px;font-weight:400;color:var(--ink-3)}
.kpi em{display:block;font-style:normal;font-size:13px;color:var(--warn);margin-top:2px}.kpi small{display:block;font-size:13px;color:var(--ink-2);margin-top:2px}
.ver{font-size:13px;color:var(--ink-3)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:14px;margin-bottom:32px;position:relative}
.grip{flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;margin:-6px -4px -6px -10px;padding:0;border:0;border-radius:8px;background:none;color:var(--ink-3);cursor:grab;touch-action:none}
.grip:hover{background:var(--tile);color:var(--ink)}
.card.dragging{position:relative;z-index:4;cursor:grabbing;box-shadow:0 18px 40px rgba(0,0,0,.2),0 2px 6px rgba(0,0,0,.08);border-color:var(--line-strong)}
.card.dragging .grip{cursor:grabbing;background:var(--tile);color:var(--ink)}
body.sorting{overflow-x:clip}
body.sorting,body.sorting *{cursor:grabbing!important;-webkit-user-select:none;user-select:none}
#order-msg:empty{display:none}#order-msg{margin:0 0 12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;display:flex;flex-direction:column;gap:12px;min-width:0}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.title{display:flex;align-items:center;gap:10px;min-width:0}
.title svg{flex:none;color:var(--ink-2)}
.title h3{font-size:16px;font-weight:600;margin:0;line-height:1.3;letter-spacing:-.01em;overflow-wrap:break-word}
.sub{font-size:13px;color:var(--ink-3);margin-top:1px;overflow-wrap:break-word}
.state{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500;padding:4px 10px;border-radius:999px;white-space:nowrap}
.state i{width:7px;height:7px;border-radius:50%;background:currentColor}
.s-ok{background:var(--ok-bg);color:var(--ok)}.s-busy{background:var(--accent-bg);color:var(--accent)}
.s-warn{background:var(--warn-bg);color:var(--warn)}.s-bad{background:var(--bad-bg);color:var(--bad)}.s-idle{background:var(--idle-bg);color:var(--idle)}
.note{font-size:13.5px;border-radius:var(--r-sm);padding:9px 11px;background:var(--tile);color:var(--ink-2)}
.note.warn{background:var(--warn-bg);color:var(--warn)}.note.bad{background:var(--bad-bg);color:var(--bad)}
.note code,.empty code,.job .vf code{font:12.5px var(--mono);background:var(--surface);color:var(--ink);padding:1px 6px;border-radius:5px;border:1px solid var(--line)}
.win+.win{margin-top:10px}
.row{display:flex;justify-content:space-between;gap:10px;font-size:13.5px}
.row span:first-child{color:var(--ink-2)}.row b{font-weight:600;font-variant-numeric:tabular-nums}
.row b.low{color:var(--warn)}.row b.out{color:var(--bad)}
.bar{height:8px;border-radius:99px;background:var(--track);overflow:hidden;margin:6px 0 4px}
.bar i{display:block;height:100%;border-radius:99px;background:var(--accent);transition:width .4s ease}
.bar i.low{background:var(--warn)}.bar i.out{background:var(--bad)}
.when{font-size:12.5px;letter-spacing:.005em;color:var(--ink-3)}
.when.pace{color:var(--warn)}
.prov{font-size:12.5px;letter-spacing:.005em;color:var(--ink-3);display:flex;align-items:center;gap:6px}
.stats{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:13px;color:var(--ink-2);border-top:1px solid var(--line);padding-top:10px}
.stats b{font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.stats .prov{margin-left:auto}
details{font-size:13px;color:var(--ink-2)}
summary{cursor:pointer;color:var(--ink-2);width:max-content;padding:4px 0;min-height:24px}
summary:hover{color:var(--ink)}
summary:active{color:var(--ink)}
.models{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px}
.models li{font:12px var(--mono);background:var(--tile);border-radius:6px;padding:3px 7px;overflow-wrap:anywhere}
.jobs{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;list-style:none;margin:0;padding:0}
.job{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 14px;align-items:start;padding:12px 16px;border-top:1px solid var(--line)}
.job:first-child{border-top:0}
.job .t{font-weight:500;overflow-wrap:anywhere}
.job .m{font:12px/1.6 var(--mono);color:var(--ink-3);overflow-wrap:anywhere}
.job .r{font-size:13px;color:var(--ink-3);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.job details{grid-column:2/4;margin-top:4px}
.job .err{color:var(--bad);font:12.5px/1.5 var(--mono);margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.job .vf{grid-column:2/4;color:var(--ink-2);font-size:12.5px;line-height:1.5;overflow-wrap:anywhere}
.job .vf.warn{color:var(--warn)}.stats .warn{color:var(--warn)}
.jobs-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.hide{background:none;border:1px solid var(--line-strong);color:var(--ink-2);border-radius:6px;font:inherit;font-size:12.5px;padding:3px 10px;min-height:28px;cursor:pointer}
.hide:hover,.hide:focus-visible{color:var(--ink);border-color:var(--ink-3)}
.job .hide{margin-top:6px}
#hide-msg:empty{display:none}
.empty{background:var(--surface);border:1px dashed var(--line-strong);border-radius:var(--r);padding:22px;color:var(--ink-2)}
.empty h3{margin:0 0 6px;font-size:16px;color:var(--ink)}
.empty ol{margin:10px 0 0;padding-left:20px;line-height:2}
footer{font-size:12.5px;letter-spacing:.005em;color:var(--ink-3);margin-top:28px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:720px){.wrap{padding:6px 16px 40px}header{margin:0 -16px 16px;padding:12px 16px}html{scroll-padding-top:112px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi b{font-size:22px}.job{grid-template-columns:auto minmax(0,1fr)}.job .r{grid-column:2;text-align:left}.job details{grid-column:1/3}.job .vf{grid-column:2/3}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media (max-height:500px){header{position:static}html{scroll-padding-top:0}}
@media (prefers-reduced-transparency:reduce),(prefers-contrast:more){header{background:var(--bg);-webkit-backdrop-filter:none;backdrop-filter:none;border-bottom:1px solid var(--line)}}
@media (prefers-contrast:more){:root{--line:var(--line-strong);--ink-3:var(--ink-2)}.card,.jobs,.kpi,.bar{border:1px solid var(--ink-3)}}
@media (forced-colors:active){.bar{border:1px solid CanvasText}.bar i,.dot,.state i{forced-color-adjust:none;background:Highlight}header{background:Canvas;-webkit-backdrop-filter:none;backdrop-filter:none}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand"><h1>omnitrix</h1><span class="ver" id="ver"></span></div>
  <div class="fresh" id="fresh"><span class="dot" aria-hidden="true"></span><span id="fresh-text">Connecting</span></div>
  <div class="sr" id="announce" role="status"></div>
</header>
<main>
  <section class="kpis" id="kpis" aria-label="Summary for the last 24 hours"></section>
  <section aria-labelledby="acc-h"><h2 id="acc-h">Accounts <small id="acc-sub"></small></h2><p id="order-msg" class="note warn" role="status"></p><div class="grid" id="accounts"></div></section>
  <section aria-labelledby="job-h"><div class="jobs-h"><h2 id="job-h">Recent jobs <small>newest first</small></h2><button type="button" class="hide" id="clear-failed" hidden>Remove failed jobs</button></div><p id="hide-msg" class="note" role="status"></p><div id="jobs"></div></section>
</main>
<footer>This page shows status and keeps the order you give the accounts; that order does not change which account omnitrix picks. Change accounts and settings with the omnitrix command.</footer>
</div>
<script>
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var fmt=function(n){n=Number(n)||0;return n>=999500?(n/1e6).toFixed(1)+'M':n>=1e3?(Math.round(n/100)/10)+'k':String(Math.round(n))};
var money=function(c){c=Number(c)||0;return c>0&&c<0.005?'under $0.01':'$'+c.toFixed(2)};
var clock=function(t){return new Date(t).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'})};
var span=function(ms){var m=Math.max(0,Math.round(ms/60000));return m<1?'under a minute':m<60?m+' min':m<1440?Math.floor(m/60)+' h'+(m%60?' '+(m%60)+' min':''):Math.floor(m/1440)+' d '+Math.floor(m%1440/60)+' h'};
var ago=function(t){var s=Math.round((Date.now()-t)/1000);return s<60?s+' s ago':s<3600?Math.round(s/60)+' min ago':s<172800?Math.round(s/3600)+' h ago':Math.round(s/86400)+' days ago'};
function icon(name){
  var p={terminal:'<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M12 15h5"/>',
    cloud:'<path d="M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.5 1.5A3.75 3.75 0 0 1 17.5 18z"/>',
    lead:'<path d="M12 3l2.2 5.6L20 10l-5.8 1.4L12 17l-2.2-5.6L4 10l5.8-1.4z"/><path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z"/>',
    chip:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'}[name];
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
}
var STATES={ready:['Ready','s-ok'],busy:['Working','s-busy'],cooling:['Resting','s-warn'],exhausted:['Out of quota','s-bad'],offline:['Offline','s-warn'],auth_error:['Needs sign-in','s-bad'],disabled:['Turned off','s-idle']};
var SOURCES={measured:'Measured by the provider',estimated:'Counted by omnitrix against your limits',untracked:'Not tracked'};
function windowHtml(w){
  var pct=w.unit==='percent', left=pct?Math.max(0,Math.min(100,w.remaining)):(w.limit>0?Math.max(0,Math.min(100,w.remaining/w.limit*100)):0);
  var cls=left<=0?'out':left<20?'low':'';
  // providers report whole percents, so a little use shows as 100% left; say so instead of looking unused
  var amount=pct?(left>=100&&w.used===0?'under 1% used':Math.round(left)+'% left'):fmt(w.remaining)+' of '+fmt(w.limit)+' '+esc(w.unit)+' left';
  var label=esc(w.name)+(pct?'':' ('+esc(w.unit)+')');
  var reset=w.resetsAt?'<div class="when">Resets in '+esc(span(w.resetsAt-Date.now()))+', '+esc(clock(w.resetsAt))+'</div>':'';
  // the server only sends runsOutAt when the current pace empties the window before it resets
  if(w.runsOutAt&&w.runsOutAt>Date.now())reset+='<div class="when pace">At this pace it runs out in about '+esc(span(w.runsOutAt-Date.now()))+', '+esc(clock(w.runsOutAt))+'</div>';
  return '<div class="win"><div class="row"><span>'+label+'</span><b class="'+cls+'">'+amount+'</b></div>'
    +'<div class="bar" role="progressbar" aria-label="'+label+' remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(left)+'" aria-valuetext="'+esc(amount)+'"><i class="'+cls+'" style="width:'+left.toFixed(1)+'%"></i></div>'+reset+'</div>';
}
var GRIP='<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="3.5" r="1.4"/><circle cx="10.5" cy="3.5" r="1.4"/><circle cx="5.5" cy="8" r="1.4"/><circle cx="10.5" cy="8" r="1.4"/><circle cx="5.5" cy="12.5" r="1.4"/><circle cx="10.5" cy="12.5" r="1.4"/></svg>';
function cardHtml(a,open,movable){
  var u=a.usage, st=STATES[a.state]||['Unknown','s-idle'];
  var ico=a.local?'chip':a.driver==='cli'?'terminal':'cloud';
  var facts=[a.owner?'Owned by '+esc(a.owner):'',esc(a.id),u.plan?esc(u.plan)+' plan':'',a.local?'Runs on this PC':'',a.trainsOnData?'Public tasks only':'',a.running?a.running+' job'+(a.running>1?'s':'')+' running':''];
  var sub=facts.filter(Boolean).join(' · ');
  var notes='';
  if(a.state!=='ready'&&a.state!=='busy'){
    var DEFAULT={exhausted:'No quota left in the current window',offline:'omnitrix cannot reach this account',cooling:'Taking a short break after errors',auth_error:'Not signed in',disabled:'Turned off in omnitrix'};
    // the engine's own reasons are lower case ("rate limited"); here they start a sentence. Provider
    // messages pass through untouched, since they may begin with a name like "openai".
    var why=String(a.reason||DEFAULT[a.state]||'').replace(/[.]+$/,'');
    if(/^(rate limited|provider error|no answer|every model is paused)/.test(why))why=why.charAt(0).toUpperCase()+why.slice(1);
    var back=a.until?' Back in '+esc(span(a.until-Date.now()))+', '+esc(clock(a.until))+'.':'';
    var fix=a.state==='auth_error'?' Run <code>omnitrix login '+esc(a.id)+'</code> to sign in again.':a.state==='disabled'?' Run <code>omnitrix enable '+esc(a.id)+'</code> to turn it on.':'';
    var text=(why?esc(why)+'.':'')+back+fix;
    if(text)notes+='<div class="note '+(st[1]==='s-bad'?'bad':st[1]==='s-warn'?'warn':'')+'">'+text+'</div>';
    // bars counted by omnitrix can show room while the provider refuses with a limit of its own
    if((a.state==='exhausted'||a.state==='cooling')&&u.source==='estimated'&&u.windows.some(function(w){return w.remaining>0}))
      notes+='<div class="note">The bars count only the limits set in omnitrix. The provider stopped this account with a limit of its own, given above.</div>';
  }
  var paused=a.pausedModels||[];
  if(paused.length)notes+='<div class="note warn">Resting after errors: '+esc(paused.join(', '))+'.'+(paused.length<(a.models||[]).length?' omnitrix uses the other models meanwhile.':'')+'</div>';
  var quota=u.windows.length?u.windows.map(windowHtml).join('')
    :a.local?'<div class="note">No usage limit. It runs on this PC.</div>'
    :a.state==='auth_error'||a.state==='disabled'?''
    :a.driver==='cli'?'<div class="note">This plan does not publish its limits, so omnitrix shows what it has sent below.</div>'
    :'<div class="note">No limit is known for this account, so omnitrix cannot show what is left. To track one, run <code>omnitrix set '+esc(a.id)+' --rpd 1000</code> with your real daily limit.</div>';
  var models=a.models||[], shown=models.slice(0,40);
  var modelHtml=models.length?'<details data-key="m-'+esc(a.id)+'"'+(open['m-'+a.id]?' open':'')+'><summary>'+models.length+' model'+(models.length>1?'s':'')+'</summary><ul class="models">'+shown.map(function(m){return '<li>'+esc(m)+'</li>'}).join('')+(models.length>shown.length?'<li>and '+(models.length-shown.length)+' more</li>':'')+'</ul></details>':'';
  var grip=movable?'<button type="button" class="grip" data-move="'+esc(a.id)+'" aria-label="Move '+esc(a.label)+'. Drag it, or use the arrow keys." title="Drag to move">'+GRIP+'</button>':'';
  return '<article class="card" data-id="'+esc(a.id)+'" aria-label="'+esc(a.label)+'">'
    +'<div class="head"><div class="title">'+grip+icon(ico)+'<div><h3>'+esc(a.label)+'</h3><div class="sub">'+sub+'</div></div></div><span class="state '+st[1]+'"><i aria-hidden="true"></i>'+st[0]+'</span></div>'
    +(quota?'<div>'+quota+'</div>':'')+notes
    +'<div class="stats"><span title="Every request to this account in the last 24 hours: jobs, failed attempts, second-model checks and omnitrix test, including jobs no longer in the list below">Last 24 h, all requests</span><span><b>'+u.requestsToday+'</b> answered</span>'+(u.failedToday?'<span class="warn"><b>'+u.failedToday+'</b> failed</span>':'')+'<span><b>'+fmt(u.tokensToday)+'</b> tokens</span>'+(u.costToday?'<span><b>'+money(u.costToday)+'</b></span>':'')
    +(u.windows.length?'<span class="prov">'+esc(SOURCES[u.source]||u.source)+(u.updatedAt&&!u.stale?', updated '+esc(ago(u.updatedAt)):'')+'</span>':'')+'</div>'
    +(u.stale&&u.updatedAt?'<div class="note warn">omnitrix could not read these numbers again. They are from '+esc(clock(u.updatedAt))+' and may be out of date.</div>':'')
    +modelHtml+'</article>';
}
// Claude itself, from the figures the Claude Code status line saved; drawn only when there are some
function leadHtml(l){
  if(!l||!l.windows||!l.windows.length)return '';
  var high=l.windows.some(function(w){return w.used_percent>=70});
  var wins=l.windows.map(function(w){return windowHtml({name:w.name,unit:'percent',remaining:100-w.used_percent,resetsAt:w.resets_at})}).join('');
  var notes=l.stale?'<div class="note warn">These figures are from '+esc(clock(l.seen_at))+'. They update only while a Claude Code session is open, so they may be out of date.</div>':'';
  if(high)notes+='<div class="note warn">'+(l.stale?'Claude was running low when last seen.':'Claude is running low.')+' omnitrix asks it to hand more work to the other accounts.</div>';
  return '<article class="card" aria-label="Claude, the lead">'
    +'<div class="head"><div class="title">'+icon('lead')+'<div><h3>Claude</h3><div class="sub">The lead: plans the work and checks every result</div></div></div><span class="state s-busy"><i aria-hidden="true"></i>Lead</span></div>'
    +'<div>'+wins+'</div>'+notes
    +'<div class="stats"><span class="prov">From the Claude Code status line'+(l.stale?'':', updated '+esc(ago(l.seen_at)))+'</span></div></article>';
}
var JOB={done:['Done','s-ok'],running:['Running','s-busy'],queued:['Waiting','s-idle'],failed:['Failed','s-bad'],cancelled:['Cancelled','s-idle']};
function jobHtml(j,open){
  var st=JOB[j.status]||[j.status,'s-idle'];
  // the ledger's total covers failed attempts too; older jobs fall back to the answering attempt
  var sp=j.spent, own=sp&&sp.tokens?sp.tokens:(j.usage?j.usage.inputTokens+j.usage.outputTokens:0);
  var tokens=own?'<span title="All attempts of this job, failed ones included'+(sp&&sp.check?', and the second model&#39;s check':'')+'">'+fmt(own+(sp?sp.check:0))+' tokens'+(sp&&sp.check?' (check: '+fmt(sp.check)+')':'')+'</span>':'';
  var verdict=j.verdict?(j.verdict==='accepted'?'Accepted by Claude':'Rejected by Claude'):'';
  var err=j.error&&j.status!=='done'?'<details data-key="e-'+esc(j.id)+'"'+(open['e-'+j.id]?' open':'')+'><summary>Why it '+(j.status==='failed'?'failed':'stopped')+'</summary><div class="err">'+esc(j.error)+'</div></details>':'';
  return '<li class="job"><span class="state '+st[1]+'"><i aria-hidden="true"></i>'+st[0]+'</span>'
    +'<div><div class="t">'+esc(j.task.title)+'</div><div class="m">'+esc(j.task.type)+(j.accountId?' · '+esc(j.accountId)+(j.model?' / '+esc(j.model):''):'')+(j.effort?' · <span'+(j.effortAuto?' title="omnitrix chose this effort from the kind of task"':'')+'>'+esc(j.effort)+' effort'+(j.effortAuto?' (auto)':'')+'</span>':'')+(j.escalatedTo?' · sent on to a stronger model':'')+'</div></div>'
    +'<div class="r">'+[tokens,ago(j.createdAt)].filter(Boolean).join(' · ')+(verdict?'<div>'+verdict+'</div>':'')+(j.status==='done'||j.status==='failed'||j.status==='cancelled'?'<div><button type="button" class="hide" data-hide="'+esc(j.id)+'" aria-label="Remove '+esc(j.task.title)+' from this list">Remove</button></div>':'')+'</div>'+err
    +(j.verify?'<div class="vf'+(j.verify.warn?' warn':'')+'">Checked by omnitrix'+(j.rebased?' after a rebase':'')+': '+esc(j.verify.summary)+'</div>':'')+sinceHtml(j)+behindHtml(j)+checkHtml(j.check)+'</li>';
}
// the branch or the checkout changed after omnitrix checked the job, so its check may not cover the code a merge takes
function sinceHtml(j){
  var s=j.sinceCheck;if(!s)return '';
  var t=[];
  if(s.branchMoved)t.push('its branch has commits that omnitrix did not check');
  if(s.files.length){var n=s.files.length+s.more;t.push(n+' file'+(n===1?'':'s')+' in its checkout changed after the check and '+(n===1?'is':'are')+' not in the commit: '+s.files.map(esc).join(', ')+(s.more?' and '+s.more+' more':''));}
  return '<div class="vf warn">Changed since the check: '+t.join('; ')+'. Review and test the code you would merge.</div>';
}
// the repository moved on after the job started; when its own files changed there, its check is out of date
function behindHtml(j){
  var b=j.behind;if(!b)return '';
  var n=b.commits+' newer commit'+(b.commits===1?'':'s');
  if(!b.files.length)return '<div class="vf">The repository has '+n+' since this job started; none of its files changed there.</div>';
  var f=b.files.map(esc).join(', ')+(b.more?' and '+b.more+' more':'');
  return '<div class="vf warn">Out of date: the repository has '+n+', and '+f+' changed there too. Run <code>omnitrix rebase '+esc(j.id)+'</code> before you review it.</div>';
}
// the second model's check, on the job it checks; a check that could not run is not a failure of the job
function checkHtml(c){
  if(!c)return '';
  var by=c.by?' by '+esc(c.by):'', note=c.note?' '+esc(c.note):'';
  var text=c.status==='pass'?'Second check'+by+': passed.'+note
    :c.status==='fail'?'Second check'+by+': failed.'+note
    :c.status==='unclear'?'Second check'+by+' gave no clear answer.'+note
    :c.status==='pending'?'Second check is running.'
    :'Second check not run:'+note;
  return '<div class="vf'+(c.status==='fail'||c.status==='unclear'?' warn':'')+'">'+text+'</div>';
}
var last=0, wasStale=null, lastRaw='', drawnMinute=-1, started=Date.now(), connected=false, savedAt=0, down=false;
var localOrder=null, localUntil=0, saving=false, wanted=null, sorting=null, held=null, heldLive=false, heldTimer=0, settleUntil=0, drawnCards='';
function tick(){
  var el=document.getElementById('fresh'), t=document.getElementById('fresh-text');
  // a stream that dropped counts as lost at once; a quiet one only after it missed its signs of life
  var stale=connected?(down||Date.now()-last>15000):Date.now()-started>8000;
  el.className='fresh'+(stale?' stale':'');
  t.textContent=!connected&&!last?(stale?'Cannot reach omnitrix. Trying again. If this stays, run omnitrix dashboard in a terminal.':'Connecting')
    :!connected?(stale?'Cannot reach omnitrix. Trying again. Showing data from '+new Date(savedAt).toLocaleTimeString()+'.':'Connecting. Showing data from '+new Date(savedAt).toLocaleTimeString()+'.')
    :stale?'Connection lost. Trying again. Showing data from '+new Date(last).toLocaleTimeString()+'.':'Live, updated '+ago(last);
  // screen readers hear only a change between live and unreachable, not every second of the clock
  if(stale!==wasStale){document.getElementById('announce').textContent=stale?'omnitrix cannot be reached':(last?'omnitrix is live':'');wasStale=stale}
}
function draw(d){
  var focused=document.activeElement&&document.activeElement.closest?document.activeElement.closest('details[data-key]'):null;
  var focusKey=focused?focused.getAttribute('data-key'):null;
  var open={};document.querySelectorAll('details[data-key]').forEach(function(x){if(x.open)open[x.getAttribute('data-key')]=true});
  document.getElementById('ver').textContent='v'+d.version+(d.installed&&d.installed!==d.version?' · '+d.installed+' is installed: run omnitrix dashboard to switch':'');
  var acc=d.accounts, ready=acc.filter(function(a){return a.state==='ready'||a.state==='busy'}).length;
  var sum=function(k){return acc.reduce(function(s,a){return s+(a.usage[k]||0)},0)};
  var attention=acc.filter(function(a){return a.enabled&&a.state!=='ready'&&a.state!=='busy'}).length;
  document.getElementById('kpis').innerHTML='<div class="kpi"><span>Accounts ready</span><b>'+ready+' of '+acc.length+'</b>'+(attention?'<em>'+attention+' need'+(attention>1?'':'s')+' attention</em>':'')+'</div>'
    +[['Requests, last 24 h',String(sum('requestsToday'))]]
    .map(function(k){return '<div class="kpi"><span>'+k[0]+'</span><b>'+esc(k[1])+'</b></div>'}).join('')
    // the work other accounts did instead of Claude, counted from the usage log
    +(function(g,o){g=g||{jobs:0,tokens:0,accepted:0};return '<div class="kpi"><span>Done by other accounts, 7 days</span><b>'+g.jobs+' job'+(g.jobs===1?'':'s')+'</b><small>'+esc(fmt(g.tokens))+' tokens'+(g.accepted?', '+g.accepted+' accepted':'')+'</small>'
      // Claude's own part, from Claude Code's session files (omnitrix overhead); absent until measured
      +(o?'<small title="Output tokens of Claude&#39;s replies that called omnitrix, and an estimate of the omnitrix results it read, over the same 7 days. Claude&#39;s plan limit also counts all its other work, so it is much higher">Claude, omnitrix calls only: '+esc(fmt(o.outputTokens))+' written, '+esc(fmt(o.resultTokens))+' read</small>':'')
      +'</div>'})(d.delegated,d.overhead)
    +'<div class="kpi"><span>Known cost, last 24 h</span><b>'+esc(money(sum('costToday')))+'</b></div>';
  document.getElementById('acc-sub').textContent=acc.length?acc.length+' connected'+(acc.length>1?'. Drag a card by its handle to arrange them.':''):'';
  // The order just given here, until the server confirms it, so a live update in between does not undo it.
  // Shortly after the save the server's order wins in any case, for example when another page changed it since.
  if(localOrder&&!saving&&(JSON.stringify(d.order||[])===JSON.stringify(localOrder)||Date.now()>localUntil))localOrder=null;
  var cards=localOrder?byOrder(acc,localOrder):acc;
  var activeGrip=document.activeElement&&document.activeElement.closest?document.activeElement.closest('.grip'):null;
  var gripId=activeGrip?activeGrip.getAttribute('data-move'):null;
  var cardsHtml=leadHtml(d.lead)+(acc.length?cards.map(function(a){return cardHtml(a,open,acc.length>1)}).join('')
    :'<div class="empty"><h3>Connect your first account</h3>omnitrix has no accounts yet. In a terminal:<ol><li><code>omnitrix init --apply</code> connects the AI tools, API keys and local models it finds on this PC</li><li><code>omnitrix providers</code> lists what you can connect</li><li><code>omnitrix add ollama</code> adds models on this PC</li><li><code>omnitrix setup-claude</code> connects omnitrix to Claude Code</li></ol></div>');
  // rebuilt only when something on the cards changed, so a card the owner just moved is not redrawn mid-motion
  if(cardsHtml!==drawnCards){
    document.getElementById('accounts').innerHTML=cardsHtml;drawnCards=cardsHtml;
    if(gripId){var gs=document.querySelectorAll('.grip');for(var k=0;k<gs.length;k++)if(gs[k].getAttribute('data-move')===gripId)gs[k].focus({preventScroll:true})}
  }
  document.getElementById('jobs').innerHTML=d.jobs.length?'<ul class="jobs">'+d.jobs.map(function(j){return jobHtml(j,open)}).join('')+'</ul>'
    :'<div class="empty"><h3>No jobs yet</h3>Ask Claude to hand out a task, and it shows up here.</div>';
  document.getElementById('clear-failed').hidden=!d.jobs.some(function(j){return j.status==='failed'||j.status==='cancelled'});
  if(focusKey){var again=document.querySelector('details[data-key="'+focusKey+'"] summary');if(again)again.focus({preventScroll:true})}
  tick();
}
// Draws a new state, and the same state again once a minute so times such as "5 min ago" stay right.
function show(raw,live){
  var minute=Math.floor(Date.now()/60000);
  if(live){last=Date.now();connected=true}
  // While a card is being moved, or is still sliding into place, the newest state waits and is drawn after.
  // This comes first, so a state that returns to the one on screen also replaces an older one that waits.
  if(sorting||Date.now()<settleUntil){held=raw;heldLive=heldLive||live;tick();if(!sorting)release();return}
  // drawn now, so a state held back earlier is older and must not be drawn over this one later
  held=null;heldLive=false;clearTimeout(heldTimer);
  if(raw===lastRaw&&minute===drawnMinute){tick();return}
  var d;try{d=JSON.parse(raw)}catch(e){return}
  lastRaw=raw;drawnMinute=minute;
  if(live){try{localStorage.setItem('omnitrix-state',raw);localStorage.setItem('omnitrix-state-at',String(Date.now()))}catch(e){}}
  draw(d);
}
// The last state this browser saw is drawn at once, then the live stream takes over.
try{var saved=localStorage.getItem('omnitrix-state');savedAt=Number(localStorage.getItem('omnitrix-state-at'))||0;if(saved)show(saved,false)}catch(e){}
var stream=null;
var polling=false;
function connect(){
  if(!window.EventSource){poll();return}
  var got=false;
  stream=new EventSource('/api/events');
  stream.onopen=function(){down=false;tick()};
  stream.onmessage=function(e){got=true;down=false;show(e.data,true)};
  // Some embedded browsers, such as the browser pane of a desktop app, hold a live stream back; the page
  // then asks for the state every few seconds instead of waiting on a stream that never arrives.
  setTimeout(function(){if(!got&&!polling&&stream){stream.close();stream=null;poll()}},4000);
  stream.addEventListener('alive',function(){down=false;last=Date.now();connected=true;if(lastRaw)show(lastRaw,false);tick()});
  stream.onerror=function(){down=true;tick()};
}
async function poll(){
  polling=true;
  try{show(await (await fetch('/api/status',{cache:'no-store'})).text(),true)}catch(e){tick()}
  setTimeout(poll,4000);
}
// The browser retries a dropped stream by itself; if it gives up, for example while the server restarts, start a new one.
setInterval(function(){if(stream&&stream.readyState===2)connect()},3000);
// Removing jobs only hides them here; Claude can still read their results.
var TOKEN=(document.querySelector('meta[name="omnitrix-token"]')||{}).content||'';
async function hide(body){
  var msg=document.getElementById('hide-msg');msg.textContent='';
  try{
    var r=await fetch('/api/hide',{method:'POST',headers:{'content-type':'application/json','x-omnitrix-token':TOKEN},body:JSON.stringify(body)});
    if(r.status===403){msg.textContent='omnitrix restarted since this page loaded. Reload the page, then try again.';return}
    if(!r.ok)throw new Error(String(r.status));
    var n=(await r.json()).hidden;msg.textContent=n?'Removed '+n+' job'+(n===1?'':'s')+' from the list.':'Nothing to remove.';
  }catch(e){msg.textContent='Could not remove: omnitrix did not answer.'}
}
document.getElementById('jobs').addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button[data-hide]');if(b){b.disabled=true;hide({ids:[b.getAttribute('data-hide')]})}});
document.getElementById('clear-failed').addEventListener('click',function(){hide({failed:true})});
// Arranging the account cards: drag one by its handle with a mouse, pen or finger, or give its handle focus and
// use the arrow keys, Home and End. omnitrix keeps the order, so every browser shows it; routing ignores it.
var grid=document.getElementById('accounts');
function reduced(){return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)}
function cardEls(){return Array.prototype.slice.call(grid.querySelectorAll('.card[data-id]'))}
function idsNow(){return cardEls().map(function(c){return c.getAttribute('data-id')})}
function nameOf(c){return c.getAttribute('aria-label')||c.getAttribute('data-id')}
function say(t){document.getElementById('announce').textContent=t}
function byOrder(list,order){
  var rank=function(id){var i=order.indexOf(id);return i<0?order.length:i};
  return list.map(function(a,i){return [a,i]}).sort(function(x,y){return rank(x[0].id)-rank(y[0].id)||x[1]-y[1]}).map(function(x){return x[0]});
}
// where a card sits in the grid, without the movement it is showing, in window coordinates
function slot(c){var g=grid.getBoundingClientRect();return {left:g.left+c.offsetLeft,top:g.top+c.offsetTop,w:c.offsetWidth,h:c.offsetHeight}}
// makes a change to the order, then slides every card from where it was to where it is now
function flip(change,skip){
  var cards=cardEls(), before=cards.map(function(c){var r=c.getBoundingClientRect();return [r.left,r.top]});
  // a slide still running from the last move ends here, so the next one starts from where the card is seen
  cards.forEach(function(c){if(c!==skip&&c.getAnimations)c.getAnimations().forEach(function(a){a.cancel()})});
  change();
  if(reduced())return;
  cards.forEach(function(c,i){
    if(c===skip||!c.animate)return;
    var r=c.getBoundingClientRect(), dx=before[i][0]-r.left, dy=before[i][1]-r.top;
    if(Math.abs(dx)+Math.abs(dy)>0.5)c.animate([{transform:'translate('+dx+'px,'+dy+'px)'},{transform:'none'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});
  });
}
function release(){
  clearTimeout(heldTimer);
  heldTimer=setTimeout(function(){
    if(sorting)return;
    if(Date.now()<settleUntil){release();return}
    var h=held, live=heldLive;held=null;heldLive=false;
    if(h){lastRaw='';show(h,live)}
  },Math.max(20,settleUntil-Date.now()+20));
}
function settle(){settleUntil=Date.now()+260}
// Only the newest order is sent, one request at a time, so a quick run of moves cannot be saved out of order.
function saveOrder(ids){localOrder=ids;wanted=ids;if(!saving)flush()}
async function flush(){
  var ids=wanted;wanted=null;
  if(!ids){saving=false;return}
  saving=true;
  var msg=document.getElementById('order-msg');
  try{
    var r=await fetch('/api/order',{method:'POST',headers:{'content-type':'application/json','x-omnitrix-token':TOKEN},body:JSON.stringify({order:ids})});
    if(r.status===403){undo('omnitrix restarted since this page loaded. Reload the page, then arrange the accounts again.');return}
    if(!r.ok)throw new Error(String(r.status));
    msg.textContent='';localUntil=Date.now()+2000;
  }catch(e){undo('Could not save the new order, because omnitrix did not answer. The accounts are back in their saved order.');return}
  flush();
}
function undo(text){
  // the cards on the page were moved by hand, so they are drawn again even though the saved state is unchanged
  saving=false;wanted=null;localOrder=null;settleUntil=0;drawnCards='';
  document.getElementById('order-msg').textContent=text;say(text);
  var raw=held||lastRaw;held=null;
  if(raw){lastRaw='';show(raw,false)}
}
function moved(card){
  var ids=idsNow(), n=ids.indexOf(card.getAttribute('data-id'));
  say(nameOf(card)+', place '+(n+1)+' of '+ids.length+'.');
  settle();saveOrder(ids);
}
grid.addEventListener('keydown',function(e){
  var g=e.target.closest&&e.target.closest('.grip');
  if(!g||sorting)return;
  var card=g.closest('.card'), list=cardEls(), i=list.indexOf(card);
  var to={ArrowUp:i-1,ArrowLeft:i-1,ArrowDown:i+1,ArrowRight:i+1,Home:0,End:list.length-1}[e.key];
  if(to===undefined)return;
  e.preventDefault();
  to=Math.max(0,Math.min(list.length-1,to));
  if(to===i){say(nameOf(card)+' is already '+(i===0?'first':'last')+'.');return}
  flip(function(){var ref=list[to];grid.insertBefore(card,to>i?ref.nextSibling:ref)});
  g.focus({preventScroll:true});
  card.scrollIntoView({block:'nearest',behavior:reduced()?'auto':'smooth'});
  moved(card);
});
grid.addEventListener('pointerdown',function(e){
  var g=e.target.closest&&e.target.closest('.grip');
  // the main button only: a finger, a pen tip or the left mouse button, not a pen's side button or a right click
  if(!g||sorting||e.button!==0)return;
  e.preventDefault();
  g.focus({preventScroll:true});
  var card=g.closest('.card'), r=card.getBoundingClientRect();
  sorting={card:card,start:idsNow(),pid:e.pointerId,x0:e.clientX,y0:e.clientY,x:e.clientX,y:e.clientY,gx:e.clientX-r.left,gy:e.clientY-r.top,lifted:false,frame:0};
});
window.addEventListener('pointermove',function(e){
  var s=sorting;
  if(!s||e.pointerId!==s.pid)return;
  // the main button was let go while another one stays down; the browser sends no pointerup until all are up
  if(!(e.buttons&1)){drop(false);return}
  s.x=e.clientX;s.y=e.clientY;
  // a small slip of a click or tap does not pick the card up
  if(!s.lifted){if(Math.abs(s.x-s.x0)+Math.abs(s.y-s.y0)<6)return;lift()}
  e.preventDefault();
  follow();
},{passive:false});
window.addEventListener('pointerup',function(e){if(sorting&&e.pointerId===sorting.pid)drop(false)});
window.addEventListener('pointercancel',function(e){if(sorting&&e.pointerId===sorting.pid)drop(true)});
window.addEventListener('keydown',function(e){if(sorting&&e.key==='Escape'){e.preventDefault();drop(true)}});
window.addEventListener('blur',function(){if(sorting)drop(true)});
// scrolling with the wheel moves the page under a still pointer, so the card and its place follow
window.addEventListener('scroll',function(){if(sorting&&sorting.lifted)follow()},{passive:true});
function lift(){
  var s=sorting;s.lifted=true;
  s.card.classList.add('dragging');document.body.classList.add('sorting');
  say('Moving '+nameOf(s.card)+'. Let go to drop it, or press Escape to cancel.');
  s.frame=requestAnimationFrame(edge);
}
function follow(){
  var s=sorting, c=s.card, hit=null;
  var under=function(p){return s.x>=p.left&&s.x<=p.left+p.w&&s.y>=p.top&&s.y<=p.top+p.h};
  cardEls().forEach(function(o){if(o!==c&&under(slot(o)))hit=o});
  if(hit){
    var list=cardEls(), from=list.indexOf(c), to=list.indexOf(hit), was=c.nextSibling, ref=to>from?hit.nextSibling:hit;
    // A move is kept only when it puts the card under the pointer. Rows of different heights could otherwise
    // make two cards swap back and forth while the pointer stands still.
    grid.insertBefore(c,ref);
    var fits=under(slot(c));
    grid.insertBefore(c,was);
    if(fits)flip(function(){grid.insertBefore(c,ref)},c);
  }
  var p=slot(c);
  c.style.transform='translate('+(s.x-s.gx-p.left)+'px,'+(s.y-s.gy-p.top)+'px)';
}
// near the top or bottom of the window the page scrolls, so a card can travel past what fits on the screen
function edge(){
  var s=sorting;if(!s||!s.lifted)return;
  var top=Math.max(0,document.querySelector('header').getBoundingClientRect().bottom)+48, bottom=window.innerHeight-48;
  var v=s.y<top?-(top-s.y)/3:s.y>bottom?(s.y-bottom)/3:0;
  if(v){window.scrollBy(0,Math.max(-22,Math.min(22,v)));follow()}
  s.frame=requestAnimationFrame(edge);
}
function drop(cancel){
  var s=sorting;sorting=null;
  if(!s)return;
  if(s.lifted){
    cancelAnimationFrame(s.frame);
    var c=s.card, was=c.getBoundingClientRect();
    document.body.classList.remove('sorting');
    if(cancel)flip(function(){s.start.forEach(function(id){var el=cardEls().filter(function(x){return x.getAttribute('data-id')===id})[0];if(el)grid.appendChild(el)})},c);
    c.style.transform='';c.classList.remove('dragging');
    // moving a card in the page takes the focus off its handle; give it back, so the arrow keys work next
    var grip=c.querySelector('.grip');if(grip)grip.focus({preventScroll:true});
    var now=c.getBoundingClientRect(), dx=was.left-now.left, dy=was.top-now.top;
    if(!reduced()&&c.animate&&Math.abs(dx)+Math.abs(dy)>0.5)c.animate([{transform:'translate('+dx+'px,'+dy+'px)'},{transform:'none'}],{duration:200,easing:'cubic-bezier(.2,.8,.2,1)'});
    settle();
    if(!cancel&&idsNow().join('|')!==s.start.join('|'))moved(c);
    else say(nameOf(c)+' stayed in place.');
  }
  if(held)release();
}
connect();setInterval(tick,1000);
</script>
</body>
</html>`;
