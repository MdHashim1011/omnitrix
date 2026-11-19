// Starts the dashboard in the background once, finds it again later, and opens at most one tab for it.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dashboardFile } from './dashboard.js';
import { homeDir, processAlive } from './store.js';
import { VERSION } from './version.js';

export const DEFAULT_PORT = 4590;
// a page retries a lost stream every 2 s (see "retry" in dashboard.ts), so 3.5 s covers one retry and a slow start
const RECONNECT_WAIT_MS = 3500;

interface Ping {
  version: string;
  pid: number;
  viewers: number;
}

async function ask<T>(port: number, what: string, timeoutMs = 1500): Promise<T | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${what}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Whatever answers on this port as an omnitrix dashboard, if anything does. */
export async function ping(port: number): Promise<Ping | undefined> {
  const p = await ask<Ping & { omnitrix?: boolean }>(port, '/api/ping');
  return p?.omnitrix && typeof p.version === 'string' && Number.isInteger(p.pid) ? { version: p.version, pid: p.pid, viewers: Number(p.viewers) || 0 } : undefined;
}

/** Opens a page in the default browser. */
export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawnSync(cmd as string, args as string[], { stdio: 'ignore', windowsHide: true });
}

function recorded(port: number): { pid?: number; port?: number } {
  try {
    return JSON.parse(fs.readFileSync(dashboardFile(port), 'utf8'));
  } catch {
    return {};
  }
}

/** True when this port is served by a dashboard that this omnitrix home started: its record names the same process. */
async function ours(port: number): Promise<Ping | undefined> {
  const p = await ping(port);
  return p && recorded(port).pid === p.pid ? p : undefined;
}

/** Stop the process that answered on the port as `pid`, and only that one. */
async function stopProcess(port: number, pid: number): Promise<boolean> {
  if ((await ping(port))?.pid !== pid) return false;
  try {
    process.kill(pid);
  } catch {
    return false;
  }
  for (let i = 0; i < 50 && processAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (recorded(port).pid === pid) fs.rmSync(dashboardFile(port), { force: true });
  return true;
}

/** Stop the background dashboard on a port, if this omnitrix home started one there. */
export async function stopDashboard(port = DEFAULT_PORT): Promise<boolean> {
  const p = await ours(port);
  if (!p) {
    // a record of a server that is gone is only litter
    if (recorded(port).pid !== undefined && (await ping(port)) === undefined) fs.rmSync(dashboardFile(port), { force: true });
    return false;
  }
  return stopProcess(port, p.pid);
}

/** The address of a running dashboard started from this omnitrix home, checked by asking it. */
export async function runningDashboard(): Promise<string | null> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(homeDir()).filter((n) => /^dashboard-\d+\.json$/.test(n));
  } catch {
    return null;
  }
  for (const name of names) {
    const port = Number(/\d+/.exec(name)![0]);
    if (await ours(port)) return `http://127.0.0.1:${port}`;
  }
  return null;
}

export interface EnsureOptions {
  port?: number;
  /** the omnitrix program to start; the one running now by default */
  cli?: string;
  /** how to open a tab; false opens none */
  open?: ((url: string) => void) | false;
}

/**
 * Make sure a dashboard of this version runs on the port, starting one in the background if needed, and
 * open a tab unless a page is already open or one was opened moments ago. Running this twice starts
 * nothing twice.
 */
export async function ensureDashboard(opts: EnsureOptions = {}): Promise<{ url: string; started: boolean; opened: boolean }> {
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  let running = await ping(port);
  // After an upgrade the old version gives way. Exactly the process that answered is stopped, so a new
  // server started meanwhile by another `omnitrix init` is never stopped by mistake.
  if (running && running.version !== VERSION) {
    await stopProcess(port, running.pid);
    running = await ping(port);
    if (running && running.version !== VERSION) throw new Error(`an older omnitrix dashboard on port ${port} could not be stopped; stop it, then try again`);
  }
  // this version answering without our record is some other program, or a dashboard of another omnitrix home
  if (running && !(await ours(port))) throw new Error(`port ${port} is used by another program; choose another with --port`);
  let started = false;
  if (!running) {
    const cli = opts.cli ?? process.argv[1]!;
    const child = spawn(process.execPath, [cli, 'dashboard', '--serve', '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    child.unref();
    for (let i = 0; i < 80 && !running; i++) {
      await new Promise((r) => setTimeout(r, 100));
      running = await ours(port);
    }
    if (!running) throw new Error(`the dashboard did not start; port ${port} may be used by another program, such as an older dashboard still running in a terminal (choose another with --port)`);
    started = true;
    // Pages that were open before a restart come back on their own within about two seconds; give them
    // the time, or a tab would open beside them.
    for (let i = 0; i < RECONNECT_WAIT_MS / 250 && running.viewers === 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      running = (await ping(port)) ?? running;
    }
  }
  let opened = false;
  if (opts.open !== false) {
    const claim = await ask<{ open: boolean }>(port, '/api/claim-open');
    if (claim?.open) {
      (opts.open ?? openBrowser)(url);
      opened = true;
    }
  }
  return { url, started, opened };
}
