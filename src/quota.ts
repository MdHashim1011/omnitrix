// Read live account quota from the Codex app server.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCommand } from './drivers/cli.js';
import { files, readJson, writeJson } from './store.js';
import type { Account } from './types.js';
import { VERSION } from './version.js';

export interface QuotaWindow {
  name: string;
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
        usedPercent: Math.max(0, Math.min(100, usedPercent)),
      };
      if (typeof resetsAt === 'number' && Number.isFinite(resetsAt * 1000)) {
        window.resetsAt = resetsAt * 1000;
      }
      windows.push(window);
    }
    if (!windows.length) return undefined;
    const quota: AccountQuota = { at: now, windows };
    if (typeof limits.planType === 'string') quota.plan = limits.planType;
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
    const quota = await readCodexQuota(profileDir);
    if (quota) writeJson(files.quota(), { ...loadQuotas(), [account.id]: quota });
  } catch {
    // Quota is a nice-to-have; a failed read must never fail the caller.
  } finally {
    reading.delete(account.id);
  }
}

/** Never rejects, so callers can start it without waiting. */
export async function refreshQuotas(accounts: Account[], maxAgeMs = 60_000): Promise<void> {
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
  await Promise.all(pending);
}

export async function readCodexQuota(profileDir: string, timeoutMs = 20000): Promise<AccountQuota | undefined> {
  try {
    const resolved = resolveCommand('codex');
    if (!resolved) return undefined;
    return await new Promise<AccountQuota | undefined>((resolve) => {
      const child = spawn(resolved.file, [...resolved.prefix, 'app-server'], {
        env: { ...process.env, CODEX_HOME: profileDir },
        windowsHide: true,
        shell: resolved.shell,
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
          child.kill();
        } catch {
          // The process may already be gone.
        }
        resolve(quota);
      };
      const timer = setTimeout(() => finish(), timeoutMs);
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
