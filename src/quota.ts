// Read live account quota from the Codex app server.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { killTree, PARENT_CREDENTIALS, resolveCommand } from './drivers/cli.js';
import { files, readJson, writeJson } from './store.js';
import type { Account } from './types.js';
import { VERSION } from './version.js';

export interface QuotaWindow {
  name: string;
  /** length of the window; readings saved before 0.1.11 lack it and get no forecast */
  minutes?: number;
  usedPercent: number;
  resetsAt?: number;
}

export interface AccountQuota {
  at: number;
  plan?: string;
  windows: QuotaWindow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCodexRateLimits(result: unknown, now = Date.now()): AccountQuota | undefined {
  try {
    if (!isRecord(result) || !isRecord(result.rateLimits)) return undefined;
    const limits = result.rateLimits;
    const windows: QuotaWindow[] = [];
    for (const value of [limits.primary, limits.secondary]) {
      if (!isRecord(value)) continue;
      const { usedPercent, windowDurationMins: mins, resetsAt } = value;
      if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)
        || typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) continue;
      const window: QuotaWindow = {
        name: mins === 300 ? '5 hours' : mins === 10080 ? '7 days' : `${mins} minutes`,
        minutes: mins,
        usedPercent: Math.max(0, Math.min(100, usedPercent)),
      };
      // A window cannot reset later than its own length from now. A later time (or one in milliseconds)
      // would keep a stale reading in use for years, so drop it and let the reading age out instead.
      if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt * 1000 <= now + (mins + 60) * 60_000) {
        window.resetsAt = resetsAt * 1000;
      }
      windows.push(window);
    }
    if (!windows.length) return undefined;
    const quota: AccountQuota = { at: now, windows };
    // The plan name reaches Claude in pool_status, so only a short plain word is allowed through.
    if (typeof limits.planType === 'string' && /^[a-z0-9_-]{1,24}$/i.test(limits.planType)) quota.plan = limits.planType;
    return quota;
  } catch {
    return undefined;
  }
}

export function loadQuotas(): Record<string, AccountQuota> {
  return readJson<Record<string, AccountQuota>>(files.quota(), {});
}

const reading = new Map<string, Promise<void>>();
// Failed reads count too, or a logged-out account would start Codex on every dashboard poll.
const lastTried = new Map<string, number>();

async function refreshOne(account: Account, profileDir: string): Promise<void> {
  try {
    // A failed read is saved as an empty reading. That replaces numbers we can no longer vouch for,
    // and its timestamp throttles the other omnitrix processes too.
    const quota = (await readCodexQuota(profileDir)) ?? { at: Date.now(), windows: [] };
    writeJson(files.quota(), { ...loadQuotas(), [account.id]: quota });
  } catch {
    // Quota is a nice-to-have; a failed read must never fail the caller.
  } finally {
    reading.delete(account.id);
  }
}

/**
 * Never rejects, so callers can start it without waiting. After `waitMs` it returns even if a read
 * is still running; that read finishes in the background and saves its result for the next caller.
 */
export async function refreshQuotas(accounts: Account[], maxAgeMs = 60_000, waitMs = Infinity): Promise<void> {
  const now = Date.now();
  const saved = loadQuotas();
  const pending: Promise<void>[] = [];
  for (const account of accounts) {
    if (!account.enabled || account.provider !== 'codex' || !account.profileDir) continue;
    let read = reading.get(account.id);
    if (!read) {
      if (now - Math.max(saved[account.id]?.at ?? 0, lastTried.get(account.id) ?? 0) < maxAgeMs) continue;
      lastTried.set(account.id, now);
      read = refreshOne(account, account.profileDir);
      reading.set(account.id, read);
    }
    pending.push(read);
  }
  if (!pending.length) return;
  let timer: NodeJS.Timeout | undefined;
  const deadline = Number.isFinite(waitMs) ? new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }) : undefined;
  await Promise.race(deadline ? [Promise.all(pending), deadline] : [Promise.all(pending)]);
  clearTimeout(timer);
}

export async function readCodexQuota(profileDir: string, timeoutMs = 20000): Promise<AccountQuota | undefined> {
  try {
    const resolved = resolveCommand('codex');
    if (!resolved) return undefined;
    return await new Promise<AccountQuota | undefined>((resolve) => {
      const env: Record<string, string | undefined> = { ...process.env, CODEX_HOME: profileDir };
      // An exported API key would make Codex report that key's limits instead of this account's plan.
      for (const k of PARENT_CREDENTIALS) delete env[k];
      const child = spawn(resolved.file, [...resolved.prefix, 'app-server'], {
        env: env as NodeJS.ProcessEnv,
        // A neutral folder, so a project's own Codex settings can't change what the app server does.
        cwd: os.tmpdir(),
        windowsHide: true,
        shell: resolved.shell,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let finished = false;
      let initialized = false;
      const lines = createInterface({ input: child.stdout });
      const finish = (quota?: AccountQuota) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        lines.close();
        try {
          // Killing a shell wrapper can leave Codex running, but Codex exits by itself when stdin closes.
          child.stdin.end();
          child.kill();
        } catch {
          // The process may already be gone.
        }
        resolve(quota);
      };
      // A Codex that never answers may also ignore stdin closing, so take down its whole process tree.
      const timer = setTimeout(() => {
        killTree(child.pid);
        finish();
      }, timeoutMs);
      const send = (message: object) => {
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch {
          finish();
        }
      };
      child.on('error', () => finish());
      child.on('exit', () => finish());
      child.stdin.on('error', () => finish());
      child.stdout.on('error', () => finish());
      child.stderr.on('error', () => finish());
      child.stderr.resume();
      lines.on('line', (line) => {
        if (finished) return;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(msg) || (msg.id !== 1 && msg.id !== 2)) return;
        if (msg.error !== undefined) {
          finish();
        } else if (msg.id === 1 && !initialized) {
          initialized = true;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          finish(parseCodexRateLimits(msg.result));
        }
      });
      send({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'omnitrix', title: 'omnitrix', version: VERSION },
      } });
    });
  } catch {
    return undefined;
  }
}
