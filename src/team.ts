// Team mode: a company shares its API accounts, prices and budgets through one file that every developer
// joins. Keys never appear in the file; each account names the environment variable that holds the key on
// every developer's machine. Personal subscriptions (ChatGPT Plus, Claude Pro) cannot be shared this way.
//
// The file and the shared folder sit where colleagues can edit them, so both are treated as untrusted:
// the file is pinned to the contents a developer reviewed, and records from the folder are checked one by one.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeModel } from './models.js';
import { getProvider, PROVIDERS } from './providers.js';
import type { Account, Limits, ModelInfo, UsageRecord } from './types.js';

export interface TeamAccountSpec {
  id: string;
  provider: string;
  label?: string;
  /** environment variable that holds the key on each developer's machine */
  keyEnv: string;
  baseUrl?: string;
  models: string[];
  limits?: Limits;
  concurrency?: number;
  trainsOnData?: boolean;
  /** spending limit for the whole team on this account, in US dollars */
  usdPerDay?: number;
  usdPerMonth?: number;
}

export interface Budget {
  usdPerDay?: number;
  usdPerMonth?: number;
}

export interface TeamFile {
  version: 1;
  name: string;
  accounts: TeamAccountSpec[];
  /** US dollars per million tokens, by model id */
  prices: Record<string, { input: number; output: number }>;
  /** every person's budget, with optional overrides by person */
  budgets?: Budget & { people: Record<string, Budget> };
  /** a shared folder where each person's spending log is collected, for team-wide reports and account limits */
  auditDir?: string;
}

/** What a developer agreed to when joining: the file, who they are, and the exact contents they reviewed. */
export interface TeamMembership {
  file: string;
  user: string;
  sha256: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MODEL = /^[\w.:/@-]{1,120}$/;
const USER = /^[\w.@+-]{1,80}$/;
// a key in the file would be readable by everyone who can read the file
const SECRET_FIELD = /^(api[_-]?key|key|secret|token|password|authorization)$/i;
// Variables that hold credentials for something other than an AI provider. A team file naming one would
// make every developer send that secret to the account's server as if it were an API key.
const NOT_AI_KEY = /^(AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$|GH_TOKEN$|GITHUB_|GITLAB_|NPM_TOKEN$|DOCKER_|SSH_|PATH$|HOME$|USERPROFILE$|APPDATA$|TEMP$|TMP$)|PASSWORD|PASSWD/;
// The variables omnitrix itself suggests for personal keys; a team should use names of its own.
const PERSONAL_KEYS = new Set(PROVIDERS.map((p) => p.keyEnv).filter((k): k is string => !!k));
// letters, digits, spaces and common punctuation; no control or direction characters
const TEXT = /^[^\p{Cc}\p{Cf}\u2028\u2029]{1,80}$/u;
const MAX_SHARED_BYTES = 10 * 1024 * 1024;

function fail(where: string, message: string): never {
  throw new Error(`team file: ${where}: ${message}`);
}

function money(where: string, name: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(where, `${name} must be a number of US dollars, 0 or more`);
  return v;
}

function budget(where: string, v: unknown): Budget {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null) fail(where, 'must be an object');
  const b = v as Record<string, unknown>;
  return { usdPerDay: money(where, 'usdPerDay', b.usdPerDay), usdPerMonth: money(where, 'usdPerMonth', b.usdPerMonth) };
}

function httpsUrl(where: string, v: unknown): string {
  let u: URL;
  try {
    u = new URL(String(v));
  } catch {
    fail(where, 'baseUrl must be a valid https:// address');
  }
  if (typeof v !== 'string' || u.protocol !== 'https:' || !u.hostname) fail(where, 'baseUrl must be a valid https:// address');
  return v;
}

/** The host a provider is reached at by default, or undefined for custom providers. */
export function officialHost(provider: string): string | undefined {
  const url = getProvider(provider)?.baseUrl;
  return url ? new URL(url).host : undefined;
}

/** Parse and check a team file. Throws a message that says exactly what to fix. */
export function parseTeam(text: string): TeamFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('file', 'is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) fail('file', 'must be a JSON object');
  const t = raw as Record<string, unknown>;
  if (t.version !== 1) fail('version', 'must be 1');
  if (typeof t.name !== 'string' || !TEXT.test(t.name.trim())) fail('name', 'must be a short text without control characters');
  if (!Array.isArray(t.accounts) || !t.accounts.length) fail('accounts', 'must list at least one account');

  const seen = new Set<string>();
  const accounts = t.accounts.map((v, i): TeamAccountSpec => {
    const where = `accounts[${i}]`;
    if (typeof v !== 'object' || v === null) fail(where, 'must be an object');
    const a = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(a)) if (SECRET_FIELD.test(k) && val !== undefined) fail(where, `"${k}": keys must never be in the team file; name the environment variable in "keyEnv" instead`);
    if (typeof a.id !== 'string' || !ID.test(a.id)) fail(where, 'id must be lower-case letters, digits and dashes');
    if (seen.has(a.id)) fail(where, `id "${a.id}" is used twice`);
    seen.add(a.id);
    const spec = typeof a.provider === 'string' ? getProvider(a.provider) : undefined;
    if (!spec) fail(where, `unknown provider "${String(a.provider)}"`);
    if (spec.driver === 'cli') fail(where, `${spec.id} is a personal subscription and cannot be shared; only API accounts can be team accounts`);
    if (spec.local) fail(where, `${spec.id} is a local model server, which each developer runs on their own machine`);
    if (typeof a.keyEnv !== 'string' || !ENV.test(a.keyEnv)) fail(where, 'keyEnv must name an environment variable, such as ACME_OPENAI_KEY');
    if (NOT_AI_KEY.test(a.keyEnv)) fail(where, `${a.keyEnv} holds a credential that is not an AI provider key`);
    let baseUrl: string | undefined;
    if (a.baseUrl !== undefined) baseUrl = httpsUrl(where, a.baseUrl);
    else if (!spec.baseUrl) fail(where, `baseUrl is required for ${spec.id}`);
    const host = new URL(baseUrl ?? spec.baseUrl!).host;
    if (PERSONAL_KEYS.has(a.keyEnv) && host !== officialHost(spec.id)) fail(where, `${a.keyEnv} usually holds a personal key and must not be sent to ${host}; use a company variable name such as ACME_${a.keyEnv}`);
    if (!Array.isArray(a.models) || !a.models.length || !a.models.every((m) => typeof m === 'string' && MODEL.test(m))) fail(where, 'models must list at least one model id');
    if (a.label !== undefined && (typeof a.label !== 'string' || !TEXT.test(a.label))) fail(where, 'label must be a short text without control characters');
    if (a.concurrency !== undefined && (!Number.isInteger(a.concurrency) || (a.concurrency as number) < 1 || (a.concurrency as number) > 32)) fail(where, 'concurrency must be a whole number from 1 to 32');
    if (a.trainsOnData !== undefined && typeof a.trainsOnData !== 'boolean') fail(where, 'trainsOnData must be true or false');
    // private work goes only to providers that do not train on it; a shared file may not loosen that
    if (a.trainsOnData === false && spec.trainsOnData) fail(where, `${spec.id} may train on prompts, and a team file cannot mark it as safe for private work`);
    if (a.limits !== undefined && (typeof a.limits !== 'object' || a.limits === null || !Object.values(a.limits).every((n) => Number.isInteger(n) && (n as number) > 0))) fail(where, 'limits must hold whole numbers above 0');
    return {
      id: a.id, provider: spec.id, label: a.label as string | undefined, keyEnv: a.keyEnv, baseUrl,
      models: a.models as string[], limits: a.limits as Limits | undefined, concurrency: a.concurrency as number | undefined,
      trainsOnData: a.trainsOnData as boolean | undefined, usdPerDay: money(where, 'usdPerDay', a.usdPerDay), usdPerMonth: money(where, 'usdPerMonth', a.usdPerMonth),
    };
  });

  // maps without a prototype, so a model or person named "__proto__" or "constructor" is just a name
  const prices: TeamFile['prices'] = Object.create(null);
  if (t.prices !== undefined) {
    if (typeof t.prices !== 'object' || t.prices === null) fail('prices', 'must be an object of model ids');
    for (const [model, p] of Object.entries(t.prices as Record<string, unknown>)) {
      const where = `prices.${model}`;
      if (typeof p !== 'object' || p === null) fail(where, 'must hold "input" and "output"');
      const q = p as Record<string, unknown>;
      prices[model] = { input: money(where, 'input', q.input) ?? fail(where, 'input is missing'), output: money(where, 'output', q.output) ?? fail(where, 'output is missing') };
    }
  }

  let budgets: TeamFile['budgets'];
  if (t.budgets !== undefined) {
    const b = budget('budgets', t.budgets);
    const people: Record<string, Budget> = Object.create(null);
    const raw = (t.budgets as Record<string, unknown>).people;
    if (raw !== undefined) {
      if (typeof raw !== 'object' || raw === null) fail('budgets.people', 'must be an object of names');
      for (const [person, pb] of Object.entries(raw as Record<string, unknown>)) people[person] = budget(`budgets.people.${person}`, pb);
    }
    budgets = { ...b, people };
  }

  if (t.auditDir !== undefined && (typeof t.auditDir !== 'string' || !path.isAbsolute(t.auditDir))) fail('auditDir', 'must be an absolute path to a shared folder');
  return { version: 1, name: t.name.trim(), accounts, prices, budgets, auditDir: t.auditDir as string | undefined };
}

export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The short form of the fingerprint that `team join` shows and asks for. */
export function reviewCode(text: string): string {
  return fingerprint(text).slice(0, 8);
}

/** Models listed for an account that the file gives no price for; their requests count as costing nothing. */
export function unpricedModels(team: TeamFile): string[] {
  return [...new Set(team.accounts.flatMap((a) => a.models))].filter((m) => !Object.hasOwn(team.prices, m));
}

/** The team's accounts as omnitrix accounts. They are rebuilt from the file on every load and never saved locally. */
export function teamAccounts(team: TeamFile): Account[] {
  return team.accounts.map((a, i) => {
    const spec = getProvider(a.provider)!;
    const price = (id: string): Partial<ModelInfo> => {
      const p = Object.hasOwn(team.prices, id) ? team.prices[id] : undefined;
      return p ? { inputPrice: p.input, outputPrice: p.output } : {};
    };
    return {
      id: a.id,
      label: a.label ?? `${team.name} ${spec.name}`,
      owner: team.name,
      provider: spec.id,
      driver: spec.driver,
      baseUrl: a.baseUrl ?? spec.baseUrl,
      apiKey: `env:${a.keyEnv}`,
      models: a.models.map((m) => makeModel(m, price(m))),
      limits: a.limits ?? spec.limits ?? {},
      concurrency: a.concurrency ?? 2,
      enabled: true,
      trainsOnData: a.trainsOnData ?? !!spec.trainsOnData,
      local: false,
      // after the developer's own accounts when scores tie
      priority: 1000 + i,
      addedAt: 'team',
      team: true,
    };
  });
}

/** A person's own budget overrides the team's, field by field. */
export function budgetFor(team: TeamFile, user: string): { day?: number; month?: number } {
  const own = team.budgets && Object.hasOwn(team.budgets.people, user) ? team.budgets.people[user] : undefined;
  const day = own?.usdPerDay ?? team.budgets?.usdPerDay;
  const month = own?.usdPerMonth ?? team.budgets?.usdPerMonth;
  return { ...(day !== undefined ? { day } : {}), ...(month !== undefined ? { month } : {}) };
}

/** US dollars for a request, from the model's price per million tokens; undefined when no price is known. */
export function estimateCost(model: ModelInfo | undefined, inputTokens: number, outputTokens: number): number | undefined {
  if (!model || (model.inputPrice === undefined && model.outputPrice === undefined)) return undefined;
  return (inputTokens * (model.inputPrice ?? 0) + outputTokens * (model.outputPrice ?? 0)) / 1_000_000;
}

export interface TeamState {
  membership: TeamMembership;
  team?: TeamFile;
  accounts: Account[];
  /** why the team's accounts are not loaded, when they are not */
  error?: string;
}

let cache: { key: string; checkedAt: number; state: TeamState } | undefined;
// a team file on a network share is looked at no more than this often, so a slow share cannot stall routing
const RECHECK_MS = 5_000;

function copy(state: TeamState): TeamState {
  // callers change accounts (a test points one at a mock, dropModel trims models); the cached copy must not change
  return { ...state, accounts: structuredClone(state.accounts) };
}

/**
 * Load the team file the developer joined. Its accounts load only while the file still has the exact
 * contents that were reviewed at join: anyone who can edit a shared file could otherwise point an account
 * at their own server and collect the keys.
 */
export function loadTeam(membership: TeamMembership): TeamState {
  const now = Date.now();
  const same = cache && cache.key.startsWith(`${membership.file}|${membership.sha256}|`);
  if (same && now - cache!.checkedAt < RECHECK_MS) return copy(cache!.state);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(membership.file);
  } catch {
    // not cached: a share that comes back is picked up at the next look
    return { membership, accounts: [], error: `the team file ${membership.file} cannot be read` };
  }
  const key = `${membership.file}|${membership.sha256}|${stat.size}|${stat.mtimeMs}`;
  if (cache?.key === key) {
    cache.checkedAt = now;
    return copy(cache.state);
  }
  let text: string;
  try {
    text = fs.readFileSync(membership.file, 'utf8');
  } catch {
    return { membership, accounts: [], error: `the team file ${membership.file} cannot be read` };
  }
  let state: TeamState;
  if (fingerprint(text) !== membership.sha256) {
    state = { membership, accounts: [], error: `the team file has changed since you joined; run "omnitrix team join ${membership.file}" to review it again` };
  } else {
    try {
      const team = parseTeam(text);
      state = { membership, team, accounts: teamAccounts(team) };
    } catch (err) {
      state = { membership, accounts: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
  cache = { key, checkedAt: now, state };
  return copy(state);
}

const usd = (v: number) => `$${v.toFixed(2)}`;

export interface TeamSummary {
  name: string;
  user: string;
  spentToday: number;
  spentMonth: number;
  dayBudget?: number;
  monthBudget?: number;
  error?: string;
  warning?: string;
}

/** A cost that counts: a finite amount of 0 or more. Anything else in a record is ignored. */
function cost(r: UsageRecord): number {
  return typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0 ? r.costUsd : 0;
}

/** Spending in US dollars since `from`, for the records that match. */
export function spent(records: Iterable<UsageRecord>, from: number, match: (r: UsageRecord) => boolean): number {
  let total = 0;
  for (const r of records) if (r.ts >= from && match(r)) total += cost(r);
  return total;
}

/** Start of the local calendar day or month. */
export function periodStart(now: number, period: 'day' | 'month'): number {
  const d = new Date(now);
  return (period === 'day' ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : new Date(d.getFullYear(), d.getMonth(), 1)).getTime();
}

/** The person's team spending today and this month, from their own records. */
export function personSpend(team: TeamFile, user: string, records: UsageRecord[], now = Date.now()): { day: number; month: number } {
  const mine = (r: UsageRecord) => r.team === team.name && r.user === user;
  return { day: spent(records, periodStart(now, 'day'), mine), month: spent(records, periodStart(now, 'month'), mine) };
}

/** Costs of requests still running, which have no record yet, by account. */
export type Reserved = Record<string, number>;

/**
 * Which team accounts are out of budget, and why. A person's budget counts their own spending on this
 * machine; an account's limit counts everyone's records from the shared folder (or only the person's own
 * when there is none). Requests still running count with their estimated cost.
 */
export function budgetBlocks(team: TeamFile, user: string, own: UsageRecord[], everyone: UsageRecord[], now = Date.now(), reserved: Reserved = {}): Record<string, string> {
  const blocked: Record<string, string> = {};
  const b = budgetFor(team, user);
  const s = personSpend(team, user, own, now);
  const running = Object.values(reserved).reduce((x, y) => x + y, 0);
  const day = s.day + running;
  const month = s.month + running;
  const personal = b.day !== undefined && day >= b.day ? `your ${team.name} budget for today is used up (${usd(day)} of ${usd(b.day)})`
    : b.month !== undefined && month >= b.month ? `your ${team.name} budget for this month is used up (${usd(month)} of ${usd(b.month)})` : undefined;
  for (const a of team.accounts) {
    if (personal) {
      blocked[a.id] = personal;
      continue;
    }
    const on = (r: UsageRecord) => r.accountId === a.id && r.team === team.name;
    const extra = reserved[a.id] ?? 0;
    const aDay = spent(everyone, periodStart(now, 'day'), on) + extra;
    const aMonth = spent(everyone, periodStart(now, 'month'), on) + extra;
    if (a.usdPerDay !== undefined && aDay >= a.usdPerDay) blocked[a.id] = `the team's daily limit for this account is used up (${usd(aDay)} of ${usd(a.usdPerDay)})`;
    else if (a.usdPerMonth !== undefined && aMonth >= a.usdPerMonth) blocked[a.id] = `the team's monthly limit for this account is used up (${usd(aMonth)} of ${usd(a.usdPerMonth)})`;
  }
  return blocked;
}

/** One file per person, so developers never write to the same file at the same time. */
function personName(user: string): string {
  return user.replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'unknown';
}

/** Copy a team record to the shared folder. A shared folder that is not reachable must never fail a job. */
export function shareRecord(auditDir: string, user: string, rec: UsageRecord): void {
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    const file = path.join(auditDir, `${personName(user)}.jsonl`);
    // never write through a link a colleague put in place of the file
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return;
    } catch {
      // no file yet
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
    const fd = fs.openSync(file, flags, 0o644);
    try {
      // the leading newline ends a line that another machine left half written, so this record stays whole
      fs.writeSync(fd, '\n' + JSON.stringify(rec) + '\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // the local ledger still has it
  }
}

const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A record from the shared folder that is well formed and belongs to the file it was found in. */
function trusted(r: unknown, owner: string, now: number): r is UsageRecord {
  if (typeof r !== 'object' || r === null) return false;
  const x = r as Record<string, unknown>;
  return typeof x.ts === 'number' && Number.isFinite(x.ts) && x.ts <= now + 5 * 60_000
    && typeof x.accountId === 'string' && ID.test(x.accountId)
    && typeof x.model === 'string' && MODEL.test(x.model)
    && typeof x.user === 'string' && USER.test(x.user) && personName(x.user) === owner
    && typeof x.team === 'string' && TEXT.test(x.team)
    && int(x.inputTokens) && int(x.outputTokens) && typeof x.ok === 'boolean'
    && (x.costUsd === undefined || (typeof x.costUsd === 'number' && Number.isFinite(x.costUsd) && x.costUsd >= 0));
}

/**
 * Every well-formed record in the shared folder since `from`. Colleagues can write there, so links,
 * folders, oversized files and records that do not belong to their file are skipped.
 */
export function readShared(auditDir: string, from = 0): UsageRecord[] {
  const out: UsageRecord[] = [];
  const now = Date.now();
  let names: string[] = [];
  try {
    names = fs.readdirSync(auditDir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return out;
  }
  for (const n of names) {
    const file = path.join(auditDir, n);
    let raw = '';
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_SHARED_BYTES || st.mtimeMs < from) continue;
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const owner = n.slice(0, -'.jsonl'.length);
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const r: unknown = JSON.parse(line);
        if (trusted(r, owner, now) && r.ts >= from) out.push(r);
      } catch {
        // a half-written line from a machine that is still writing
      }
    }
  }
  return out;
}
