import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account, AccountHealth, Config, Settings } from './types.js';

export function homeDir(): string {
  return process.env.OMNITRIX_HOME || path.join(os.homedir(), '.omnitrix');
}

export const files = {
  config: () => path.join(homeDir(), 'config.json'),
  secrets: () => path.join(homeDir(), 'secrets.json'),
  ledger: () => path.join(homeDir(), 'usage.jsonl'),
  health: () => path.join(homeDir(), 'health.json'),
  stats: () => path.join(homeDir(), 'stats.json'),
  jobs: () => path.join(homeDir(), 'jobs'),
  outputs: () => path.join(homeDir(), 'outputs'),
  profiles: () => path.join(homeDir(), 'profiles'),
  worktrees: () => path.join(homeDir(), 'worktrees'),
};

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
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Write to a temp file then rename, so a crash never leaves half a file. */
export function writeJson(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can refuse a rename over a file another process has open; fall back to a direct write.
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode });
    fs.rmSync(tmp, { force: true });
    if (!fs.existsSync(file)) throw err;
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
  return cfg;
}

export function saveConfig(cfg: Config): void {
  ensureHome();
  writeJson(files.config(), cfg);
}

export function findAccount(cfg: Config, id: string): Account | undefined {
  return cfg.accounts.find((a) => a.id === id);
}

type Secrets = Record<string, string>;

export function setSecret(accountId: string, value: string): void {
  ensureHome();
  const all = readJson<Secrets>(files.secrets(), {});
  all[accountId] = value;
  writeJson(files.secrets(), all, 0o600);
}

export function deleteSecret(accountId: string): void {
  const all = readJson<Secrets>(files.secrets(), {});
  if (accountId in all) {
    delete all[accountId];
    writeJson(files.secrets(), all, 0o600);
  }
}

/** Resolve the API key of an account. Never log the return value. */
export function resolveKey(account: Account): string | undefined {
  const ref = account.apiKey;
  if (!ref) return undefined;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] || undefined;
  if (ref === 'secret') return readJson<Secrets>(files.secrets(), {})[account.id];
  return undefined;
}

export function loadHealth(): Record<string, AccountHealth> {
  return readJson<Record<string, AccountHealth>>(files.health(), {});
}

/** Stamps each entry with the time it was written, so readers can tell which process saw the account last. */
export function saveHealth(update: Record<string, AccountHealth>): void {
  const now = Date.now();
  const merged = loadHealth();
  for (const [id, h] of Object.entries(update)) merged[id] = { ...h, at: h.at ?? now };
  writeJson(files.health(), merged);
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
  return text
    .replace(/(sk|pk|rk|gsk|xai|nvapi|hf)[-_][A-Za-z0-9_\-]{12,}/g, '$1-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi, '$1***')
    .replace(/("?(api[_-]?key|authorization|x-api-key|token)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi, '$1***');
}
