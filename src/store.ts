// Everything omnitrix keeps lives in one folder, ~/.omnitrix unless OMNITRIX_HOME says otherwise.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTeam } from './team.js';
import type { Account, AccountHealth, Config, Settings } from './types.js';

export function homeDir(): string {
  return process.env.OMNITRIX_HOME || path.join(os.homedir(), '.omnitrix');
}

export const files = {
  config: () => path.join(homeDir(), 'config.json'),
  secrets: () => path.join(homeDir(), 'secrets.json'),
  ledger: () => path.join(homeDir(), 'usage.jsonl'),
  health: () => path.join(homeDir(), 'health.json'),
  quota: () => path.join(homeDir(), 'quota.json'),
  lead: () => path.join(homeDir(), 'lead-quota.json'),
  stats: () => path.join(homeDir(), 'stats.json'),
  jobs: () => path.join(homeDir(), 'jobs'),
  outputs: () => path.join(homeDir(), 'outputs'),
  profiles: () => path.join(homeDir(), 'profiles'),
  worktrees: () => path.join(homeDir(), 'worktrees'),
  seats: () => path.join(homeDir(), 'seats'),
  owners: () => path.join(homeDir(), 'owners'),
  dashboard: () => path.join(homeDir(), 'dashboard.json'),
};

/** What job ids look like (see newId in engine.ts). Anything else could name a file outside the jobs folder. */
export const JOB_ID = /^j[0-9a-z]{4,40}$/;

/** A path with links followed as far as it exists; the missing rest is added back unchanged. */
function realish(p: string): string {
  const full = path.resolve(p);
  try {
    return fs.realpathSync.native(full);
  } catch {
    const up = path.dirname(full);
    return up === full ? full : path.join(realish(up), path.basename(full));
  }
}

/** True when `child` is `parent` or inside it, after following links as far as each path exists. */
export function inside(child: string, parent: string): boolean {
  try {
    const c = realish(child);
    const p = realish(parent);
    const rel = path.relative(p, c);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

export function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const defaultSettings: Settings = {
  protectPrivate: true,
  resultPreviewChars: 1500,
  jobTimeoutSec: 900,
  mode: 'balanced',
  bannedProviders: [],
  pins: {},
};

export function ensureHome(): void {
  for (const dir of [homeDir(), files.jobs(), files.outputs(), files.profiles(), files.worktrees()]) {
    // keys, prompts and results live here; on macOS and Linux only the owner may read them
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // a folder made by an older version keeps its old permissions unless they are tightened
  if (process.platform !== 'win32') fs.chmodSync(homeDir(), 0o700);
}

const pause = new Int32Array(new SharedArrayBuffer(4));

// A lock that names no readable process and is older than this was left half-written by a crash.
const STALE_LOCK_MS = 10_000;
// After this long, the change goes ahead without the lock rather than hang the caller.
const LOCK_WAIT_MS = 5_000;

/** The text the holder wrote into the lock, or undefined while there is none to read. */
function lockHolder(lock: string): string | undefined {
  try {
    return fs.readFileSync(lock, 'utf8') || undefined;
  } catch {
    return undefined;
  }
}

/** True when a lock was left by a process that is gone, so it can be taken over at once. */
function abandoned(lock: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(lock, 'utf8');
  } catch {
    return false; // gone already, or being replaced
  }
  const pid = Number(text.split(' ')[0]);
  if (Number.isInteger(pid) && pid > 0) return !processAlive(pid);
  try {
    return Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

/**
 * Delete a lock whose process is gone. Only one waiter at a time may do this, and it looks again while it may:
 * otherwise a second waiter that saw the same old lock could delete the fresh lock that the first one just took.
 */
function removeAbandoned(lock: string, mine: string): void {
  const guard = `${lock}.takeover`;
  let fd: number;
  try {
    fd = fs.openSync(guard, 'wx');
  } catch {
    // Another waiter is taking over. The guard names its holder too, so one left by a crash is cleared at once,
    // and one whose holder lives is never cleared, however long the system paused that holder.
    if (abandoned(guard)) fs.rmSync(guard, { force: true });
    return;
  }
  try {
    fs.writeSync(fd, mine);
    // Another waiter that cleared this guard by mistake may be taking over now; then leave the lock to it.
    if (abandoned(lock) && lockHolder(guard) === mine) fs.rmSync(lock, { force: true });
  } finally {
    fs.closeSync(fd);
    if (lockHolder(guard) === mine) fs.rmSync(guard, { force: true });
  }
}

/**
 * Run `fn` while holding a lock file beside `file`. Several omnitrix processes change the same files
 * (verdicts, account health, quota readings, keys) by reading, changing and writing them; without the
 * lock, one process's write silently replaces another's.
 */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The wait counts from the last change of holder: busy processes that pass the lock on are working,
  // and only one holder that keeps it this long is treated as stuck.
  let deadline = Date.now() + LOCK_WAIT_MS;
  let holder: string | undefined;
  let fd: number | undefined;
  let looked = Date.now();
  // the lock names its holder, so a lock left by a crashed process is recognised at once
  const mine = `${process.pid} ${Math.random().toString(36).slice(2)}`;
  while (fd === undefined) {
    try {
      const opened = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(opened, mine);
      } catch (err) {
        // an empty lock left behind would hold up the next processes and then let them go ahead together
        fs.closeSync(opened);
        fs.rmSync(lock, { force: true });
        throw err;
      }
      fd = opened;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows answers EPERM while another process is deleting the lock
      if (code !== 'EEXIST' && code !== 'EPERM') throw err;
      if (abandoned(lock)) removeAbandoned(lock, mine);
      const now = lockHolder(lock);
      if (now !== undefined && now !== holder) {
        holder = now;
        deadline = Date.now() + LOCK_WAIT_MS;
      }
      // Time in which the system paused this process is not time that the holder kept the lock.
      const t = Date.now();
      if (t - looked > 1000) deadline = Math.max(deadline, t + LOCK_WAIT_MS);
      looked = t;
      if (Date.now() > deadline) {
        process.stderr.write(`omnitrix: ${path.basename(file)} stayed locked for ${LOCK_WAIT_MS / 1000} s; changing it without the lock\n`);
        break;
      }
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }
}

/** Write to a temp file then rename, so no reader ever sees half a file. */
export function writeJson(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  // flushed to disk before the rename, so a power cut cannot leave the renamed file empty
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  // Windows refuses the rename while a virus scanner or indexer has the target open. That clears within
  // moments, so wait and retry. Writing the target in place instead would let other processes read it empty.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(pause, 0, 0, 25);
    }
  }
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function loadConfig(): Config {
  const cfg = readJson<Config | null>(files.config(), null);
  if (!cfg) return { version: 1, accounts: [], settings: { ...defaultSettings } };
  cfg.settings = { ...defaultSettings, ...cfg.settings };
  cfg.accounts ??= [];
  if (cfg.settings.team) {
    // the developer's own account wins when an id is used by both
    const own = new Set(cfg.accounts.map((a) => a.id));
    cfg.accounts.push(...loadTeam(cfg.settings.team).accounts.filter((a) => !own.has(a.id)));
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  // team accounts come from the team file on every load; saving them would freeze an old copy here
  writeJson(files.config(), { ...cfg, accounts: cfg.accounts.filter((a) => !a.team) });
}

/**
 * Change the configuration under its lock: read the latest copy, apply `change`, save. Every change goes
 * through here, so a command that waited for a provider never writes back a copy that is out of date.
 * `change` must not wait for anything; fetch first, then change.
 */
export function updateConfig<T>(change: (cfg: Config) => T): T {
  ensureHome();
  return withLock(files.config(), () => {
    const cfg = loadConfig();
    const result = change(cfg);
    saveConfig(cfg);
    return result;
  });
}

/** Remove a model the provider no longer serves, so the router stops choosing it. */
export function dropModel(accountId: string, modelId: string): void {
  updateConfig((cfg) => {
    const acc = findAccount(cfg, accountId);
    // a team account is rebuilt from the team file on every load; its model rests instead (see the engine)
    if (!acc || acc.team || !acc.models.some((m) => m.id === modelId)) return;
    acc.models = acc.models.filter((m) => m.id !== modelId);
  });
}

export function findAccount(cfg: Config, id: string): Account | undefined {
  return cfg.accounts.find((a) => a.id === id);
}

type Secrets = Record<string, string>;

export function setSecret(accountId: string, value: string): void {
  ensureHome();
  withLock(files.secrets(), () => {
    const all = readJson<Secrets>(files.secrets(), {});
    all[accountId] = value;
    writeJson(files.secrets(), all, 0o600);
  });
}

export function deleteSecret(accountId: string): void {
  withLock(files.secrets(), () => {
    const all = readJson<Secrets>(files.secrets(), {});
    if (accountId in all) {
      delete all[accountId];
      writeJson(files.secrets(), all, 0o600);
    }
  });
}

/** Resolve the API key of an account. Never log the return value. */
export function resolveKey(account: Account): string | undefined {
  const ref = account.apiKey;
  if (!ref) return undefined;
  if (ref.startsWith('env:')) return known(process.env[ref.slice(4)] || undefined);
  if (ref === 'secret') return known(readJson<Secrets>(files.secrets(), {})[account.id]);
  return undefined;
}

// Every key omnitrix has handed to a driver, so redact() can hide it even when it has no familiar prefix.
const knownKeys = new Set<string>();
function known(key: string | undefined): string | undefined {
  if (key && key.length >= 12) knownKeys.add(key);
  return key;
}

export function loadHealth(): Record<string, AccountHealth> {
  return readJson<Record<string, AccountHealth>>(files.health(), {});
}

/** Stamps each entry with the time it was written, so readers can tell which process saw the account last. */
export function saveHealth(update: Record<string, AccountHealth>): void {
  withLock(files.health(), () => {
    const now = Date.now();
    const merged = loadHealth();
    for (const [id, h] of Object.entries(update)) merged[id] = { ...h, at: h.at ?? now };
    // model pauses (keys "account/model") that have run out carry no information, so they are dropped
    for (const [id, h] of Object.entries(merged)) if (id.includes('/') && h.state === 'cooling' && (h.until ?? 0) <= now) delete merged[id];
    writeJson(files.health(), merged);
  });
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'account';
}

export function uniqueAccountId(cfg: Config, base: string): string {
  const root = slug(base);
  let id = root;
  let n = 2;
  while (findAccount(cfg, id)) id = `${root}-${n++}`;
  return id;
}

/** Hide anything that looks like a secret before it is shown or saved. */
export function redact(text: string): string {
  let out = text;
  for (const key of knownKeys) out = out.split(key).join('***');
  return out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----PRIVATE KEY***-----')
    .replace(/\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '$1_***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\b(xox[abprs])-[A-Za-z0-9-]{10,}/g, '$1-***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt-***')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza***')
    .replace(/\bfw_[A-Za-z0-9]{16,}/g, 'fw_***')
    .replace(/\b(sk|pk|rk|gsk|xai|nvapi|hf)[-_][A-Za-z0-9_\-]{12,}/g, '$1-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi, '$1***')
    .replace(/("?(api[_-]?key|authorization|x-api-key|token)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi, '$1***');
}
