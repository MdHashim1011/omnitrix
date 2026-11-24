// A small local web page with the same numbers as `omnitrix list`. One live stream sends every change to
// every open page, so nobody has to reload it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Engine } from './engine.js';
import { refreshQuotas } from './quota.js';
import { ensureHome, homeDir, writeJson } from './store.js';
import type { Job } from './types.js';
import { verifySummary } from './verify.js';
import { ICON_SVG } from './icon.js';
import { leadOut, loadLeadQuota } from './lead.js';
import { claudeProjectsDir, measureOverhead, resultTokens, type Overhead } from './overhead.js';
import { VERSION } from './version.js';

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
  return engine.listJobs(limit * 2).filter((j) => !j.checkOf).slice(0, limit).map((j) => ({
    id: j.id,
    status: j.status,
    accountId: j.accountId,
    model: j.model,
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

export function startDashboard(port: number): { url: string; server: http.Server; close: () => Promise<void> } {
  const engine = new Engine();
  const viewers = new Set<http.ServerResponse>();
  let latest = '';
  let slowAt = 0;
  let openedAt = 0;

  const behindOf = behindReader(engine);
  const sinceOf = sinceCheckReader(engine);
  const overheadOf = overheadReader();
  const snapshot = (): string => JSON.stringify({ version: VERSION, accounts: engine.pool(), jobs: recentJobs(engine, 30, behindOf, sinceOf), delegated: engine.delegated(7), overhead: overheadOf(), lead: leadOut(loadLeadQuota()) });
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
      slowChecks();
      json(res, { version: VERSION, now: Date.now(), accounts: engine.pool(), jobs: recentJobs(engine), delegated: engine.delegated(7), overhead: overheadOf(), lead: leadOut(loadLeadQuota()) });
      return;
    }
    if (req.url === '/api/ping') {
      json(res, { omnitrix: true, version: VERSION, pid: process.pid, viewers: viewers.size });
      return;
    }
    // asked by `omnitrix dashboard` and `omnitrix init` before they open a tab: one tab is enough
    if (req.url === '/api/claim-open') {
      const open = viewers.size === 0 && Date.now() - openedAt > OPEN_GRACE_MS;
      if (open) openedAt = Date.now();
      json(res, { open });
      return;
    }
    if (req.url === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' }).end(ICON_SVG);
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' }).end(PAGE);
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:14px;margin-bottom:32px}
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
  <section aria-labelledby="acc-h"><h2 id="acc-h">Accounts <small id="acc-sub"></small></h2><div class="grid" id="accounts"></div></section>
  <section aria-labelledby="job-h"><h2 id="job-h">Recent jobs <small>newest first</small></h2><div id="jobs"></div></section>
</main>
<footer>This page only shows status. Change accounts and settings with the omnitrix command.</footer>
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
  var amount=pct?Math.round(left)+'% left':fmt(w.remaining)+' of '+fmt(w.limit)+' '+esc(w.unit)+' left';
  var label=esc(w.name)+(pct?'':' ('+esc(w.unit)+')');
  var reset=w.resetsAt?'<div class="when">Resets in '+esc(span(w.resetsAt-Date.now()))+', '+esc(clock(w.resetsAt))+'</div>':'';
  // the server only sends runsOutAt when the current pace empties the window before it resets
  if(w.runsOutAt&&w.runsOutAt>Date.now())reset+='<div class="when pace">At this pace it runs out in about '+esc(span(w.runsOutAt-Date.now()))+', '+esc(clock(w.runsOutAt))+'</div>';
  return '<div class="win"><div class="row"><span>'+label+'</span><b class="'+cls+'">'+amount+'</b></div>'
    +'<div class="bar" role="progressbar" aria-label="'+label+' remaining" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(left)+'" aria-valuetext="'+esc(amount)+'"><i class="'+cls+'" style="width:'+left.toFixed(1)+'%"></i></div>'+reset+'</div>';
}
function cardHtml(a,open){
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
  return '<article class="card" aria-label="'+esc(a.label)+'">'
    +'<div class="head"><div class="title">'+icon(ico)+'<div><h3>'+esc(a.label)+'</h3><div class="sub">'+sub+'</div></div></div><span class="state '+st[1]+'"><i aria-hidden="true"></i>'+st[0]+'</span></div>'
    +(quota?'<div>'+quota+'</div>':'')+notes
    +'<div class="stats"><span>Last 24 h</span><span><b>'+u.requestsToday+'</b> answered</span>'+(u.failedToday?'<span class="warn"><b>'+u.failedToday+'</b> failed</span>':'')+'<span><b>'+fmt(u.tokensToday)+'</b> tokens</span>'+(u.costToday?'<span><b>'+money(u.costToday)+'</b></span>':'')
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
  var tokens=j.usage?fmt(j.usage.inputTokens+j.usage.outputTokens)+' tokens':'';
  var verdict=j.verdict?(j.verdict==='accepted'?'Accepted by Claude':'Rejected by Claude'):'';
  var err=j.error&&j.status!=='done'?'<details data-key="e-'+esc(j.id)+'"'+(open['e-'+j.id]?' open':'')+'><summary>Why it '+(j.status==='failed'?'failed':'stopped')+'</summary><div class="err">'+esc(j.error)+'</div></details>':'';
  return '<li class="job"><span class="state '+st[1]+'"><i aria-hidden="true"></i>'+st[0]+'</span>'
    +'<div><div class="t">'+esc(j.task.title)+'</div><div class="m">'+esc(j.task.type)+(j.accountId?' · '+esc(j.accountId)+(j.model?' / '+esc(j.model):''):'')+'</div></div>'
    +'<div class="r">'+[tokens,ago(j.createdAt)].filter(Boolean).join(' · ')+(verdict?'<div>'+verdict+'</div>':'')+'</div>'+err
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
  document.getElementById('ver').textContent='v'+d.version;
  var acc=d.accounts, ready=acc.filter(function(a){return a.state==='ready'||a.state==='busy'}).length;
  var sum=function(k){return acc.reduce(function(s,a){return s+(a.usage[k]||0)},0)};
  var attention=acc.filter(function(a){return a.enabled&&a.state!=='ready'&&a.state!=='busy'}).length;
  document.getElementById('kpis').innerHTML='<div class="kpi"><span>Accounts ready</span><b>'+ready+' of '+acc.length+'</b>'+(attention?'<em>'+attention+' need'+(attention>1?'':'s')+' attention</em>':'')+'</div>'
    +[['Requests, last 24 h',String(sum('requestsToday'))]]
    .map(function(k){return '<div class="kpi"><span>'+k[0]+'</span><b>'+esc(k[1])+'</b></div>'}).join('')
    // the work other accounts did instead of Claude, counted from the usage log
    +(function(g,o){g=g||{jobs:0,tokens:0,accepted:0};return '<div class="kpi"><span>Done by other accounts, 7 days</span><b>'+g.jobs+' job'+(g.jobs===1?'':'s')+'</b><small>'+esc(fmt(g.tokens))+' tokens'+(g.accepted?', '+g.accepted+' accepted':'')+'</small>'
      // Claude's own part, from Claude Code's session files (omnitrix overhead); absent until measured
      +(o?'<small title="Output tokens of Claude&#39;s replies that called omnitrix, and an estimate of the omnitrix results it read, over the same 7 days">Claude: '+esc(fmt(o.outputTokens))+' written, '+esc(fmt(o.resultTokens))+' read</small>':'')
      +'</div>'})(d.delegated,d.overhead)
    +'<div class="kpi"><span>Known cost, last 24 h</span><b>'+esc(money(sum('costToday')))+'</b></div>';
  document.getElementById('acc-sub').textContent=acc.length?acc.length+' connected':'';
  document.getElementById('accounts').innerHTML=leadHtml(d.lead)+(acc.length?acc.map(function(a){return cardHtml(a,open)}).join('')
    :'<div class="empty"><h3>Connect your first account</h3>omnitrix has no accounts yet. In a terminal:<ol><li><code>omnitrix init --apply</code> connects the AI tools, API keys and local models it finds on this PC</li><li><code>omnitrix providers</code> lists what you can connect</li><li><code>omnitrix add ollama</code> adds models on this PC</li><li><code>omnitrix setup-claude</code> connects omnitrix to Claude Code</li></ol></div>');
  document.getElementById('jobs').innerHTML=d.jobs.length?'<ul class="jobs">'+d.jobs.map(function(j){return jobHtml(j,open)}).join('')+'</ul>'
    :'<div class="empty"><h3>No jobs yet</h3>Ask Claude to hand out a task, and it shows up here.</div>';
  if(focusKey){var again=document.querySelector('details[data-key="'+focusKey+'"] summary');if(again)again.focus({preventScroll:true})}
  tick();
}
// Draws a new state, and the same state again once a minute so times such as "5 min ago" stay right.
function show(raw,live){
  var minute=Math.floor(Date.now()/60000);
  if(live){last=Date.now();connected=true}
  if(raw===lastRaw&&minute===drawnMinute){tick();return}
  var d;try{d=JSON.parse(raw)}catch(e){return}
  lastRaw=raw;drawnMinute=minute;
  if(live){try{localStorage.setItem('omnitrix-state',raw);localStorage.setItem('omnitrix-state-at',String(Date.now()))}catch(e){}}
  draw(d);
}
// The last state this browser saw is drawn at once, then the live stream takes over.
try{var saved=localStorage.getItem('omnitrix-state');savedAt=Number(localStorage.getItem('omnitrix-state-at'))||0;if(saved)show(saved,false)}catch(e){}
var stream=null;
function connect(){
  if(!window.EventSource){poll();return}
  stream=new EventSource('/api/events');
  stream.onopen=function(){down=false;tick()};
  stream.onmessage=function(e){down=false;show(e.data,true)};
  stream.addEventListener('alive',function(){down=false;last=Date.now();connected=true;if(lastRaw)show(lastRaw,false);tick()});
  stream.onerror=function(){down=true;tick()};
}
async function poll(){
  try{show(await (await fetch('/api/status',{cache:'no-store'})).text(),true)}catch(e){tick()}
  setTimeout(poll,4000);
}
// The browser retries a dropped stream by itself; if it gives up, for example while the server restarts, start a new one.
setInterval(function(){if(stream&&stream.readyState===2)connect()},3000);
connect();setInterval(tick,1000);
</script>
</body>
</html>`;
