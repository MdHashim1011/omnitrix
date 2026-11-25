// Picks the account and model for a task. Hard rules go first (privacy, health, quota, what the driver
// can do); whatever is left gets a score, and the highest score gets the task.
import { basisOf, statsKey } from './models.js';
import { acceptanceFactor } from './stats.js';
import { headroom, roughSpan, type UsageSummary } from './usage.js';
import type { Account, AccountHealth, Config, ModelInfo, Privacy, RouteDef, Settings, Skills, TaskSpec, TaskType } from './types.js';

/** How much each skill matters for each kind of task. Each row adds up to 1. */
const WEIGHTS: Record<TaskType, Partial<Record<keyof Skills, number>>> = {
  code: { coding: 0.7, reasoning: 0.2, speed: 0.1 },
  code_snippet: { coding: 0.7, reasoning: 0.2, speed: 0.1 },
  review: { reasoning: 0.5, coding: 0.4, longContext: 0.1 },
  reasoning: { reasoning: 0.8, coding: 0.1, writing: 0.1 },
  long_context: { longContext: 0.6, reasoning: 0.3, speed: 0.1 },
  bulk: { speed: 0.5, writing: 0.3, reasoning: 0.2 },
  writing: { writing: 0.7, reasoning: 0.2, speed: 0.1 },
  vision: { vision: 0.7, reasoning: 0.3 },
};

export interface Candidate {
  accountId: string;
  model: string;
  score: number;
  why: string[];
}

export interface Rejected {
  accountId: string;
  model?: string;
  reason: string;
}

export interface RouteContext {
  config: Config;
  health: Record<string, AccountHealth>;
  usage: Record<string, UsageSummary>;
  /** running jobs per account */
  running: Record<string, number>;
  stats: Record<string, { ok: number; bad: number; at: number }>;
  now?: number;
  /** accounts that must not be used right now, with the reason (team budgets) */
  blocked?: Record<string, string>;
  /** typical answer time in ms per "account/model", from usage (see typicalLatency) */
  latency?: Record<string, number>;
  /** memory of this computer's graphics card in bytes, when known (NVIDIA only) */
  gpuBytes?: number;
  /** size in bytes of local models per "account/model", as the local server reports it */
  localSizes?: Record<string, number>;
  /** OpenCode is installed, so an API account can do code tasks through it */
  apiAgent?: boolean;
}

// a local model larger than the graphics card's memory runs mostly on the processor, many times slower
const TOO_BIG_FOR_GPU = 0.4;

/** True when the address is this computer, so a "local" account really keeps prompts here. */
export function loopback(baseUrl: string | undefined): boolean {
  try {
    const host = new URL(baseUrl ?? '').hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

export function fit(skills: Skills, type: TaskType): number {
  let total = 0;
  for (const [skill, w] of Object.entries(WEIGHTS[type])) total += (skills[skill as keyof Skills] ?? 0) * (w ?? 0);
  return total / 10;
}

function costFactor(model: ModelInfo, account: Account, mode: Config['settings']['mode'], type: TaskType): number {
  if (mode === 'quality') return 1;
  const price = (model.inputPrice ?? 0) + (model.outputPrice ?? 0) * 3;
  if (account.local || price === 0) return 1; // free, local, or already paid for by a plan
  // bulk work is where paying per token adds up, so cost counts for more there
  const strength = mode === 'saver' ? 1 : type === 'bulk' ? 0.6 : 0.25;
  return 1 / (1 + (price / 20) * strength);
}

// These multiply the score after the quota factor. They can reorder accounts of similar fit, not
// overturn a large difference in fit, and a pin still outranks them.
const RESET_SOON_MS = 60 * 60_000;
const RESET_SOON_MIN_LEFT = 0.2;
// Big enough to beat an account with somewhat more quota left, since the quota factor otherwise counts
// soon-to-vanish quota against the account that should spend it.
const RESET_SOON_BONUS = 1.25;
const RUNNING_OUT_PENALTY = 0.75;
const PUBLIC_ONLY_BONUS = 1.15;

/** No price is known. Prices are only set by hand, so this does not prove the model is free. */
function unpriced(model: ModelInfo): boolean {
  return !model.inputPrice && !model.outputPrice;
}

/**
 * An account forecast to run dry is spared; otherwise quota that resets soon is used before it is lost.
 * `room` is the account's tightest window, so a nearly spent weekly window blocks the bonus of a
 * 5-hour window: spending the 5-hour quota would spend the weekly quota too.
 */
function timing(usage: UsageSummary | undefined, room: number, now: number): { factor: number; why: string[] } {
  const windows = usage?.windows ?? [];
  const dry = windows.filter((w) => w.runsOutAt && w.runsOutAt > now).sort((a, b) => a.runsOutAt! - b.runsOutAt!)[0];
  if (dry) return { factor: RUNNING_OUT_PENALTY, why: [`${dry.name} runs out in about ${roughSpan(dry.runsOutAt! - now)} at this pace`] };
  const soon = room >= RESET_SOON_MIN_LEFT && windows.find((w) => w.resetsAt && w.resetsAt > now && w.resetsAt - now <= RESET_SOON_MS);
  if (soon) return { factor: RESET_SOON_BONUS, why: [`${soon.name} resets in ${roughSpan(soon.resetsAt! - now)} with ${Math.round(room * 100)}% left`] };
  return { factor: 1, why: [] };
}

/** The routes everyone has. A route of the user's own with the same name replaces one of these. */
export const BUILTIN_ROUTES: Record<string, RouteDef> = {
  fast: { description: 'models that answered quickly before; for small lookups and quick drafts', fast: true },
  deep: { description: 'the strongest models, ranked by strength alone; for hard reviews, reasoning and tricky code', mode: 'quality' },
  cheap: { description: 'free, local and plan-included models first; for bulk work and first drafts', mode: 'saver' },
  local: { description: 'models on this computer only; nothing leaves the machine', local: true },
};

export function routeDef(name: string, settings: Settings): RouteDef | undefined {
  return Object.hasOwn(settings.routes ?? {}, name) ? settings.routes![name] : Object.hasOwn(BUILTIN_ROUTES, name) ? BUILTIN_ROUTES[name] : undefined;
}

/** Every route Claude may name, built-in ones first, each with the description Claude chooses by. */
export function routeList(settings: Settings): { name: string; description: string }[] {
  const names = [...Object.keys(BUILTIN_ROUTES), ...Object.keys(settings.routes ?? {}).filter((n) => !Object.hasOwn(BUILTIN_ROUTES, n))];
  return names.map((name) => ({ name, description: routeDef(name, settings)!.description }));
}

export function effectivePrivacy(task: TaskSpec): Privacy {
  return task.privacy ?? 'private';
}

/** Rank every account+model that can do this task. Best first. */
export function route(task: TaskSpec, ctx: RouteContext): { candidates: Candidate[]; rejected: Rejected[] } {
  const now = ctx.now ?? Date.now();
  const { settings } = ctx.config;
  const privacy = effectivePrivacy(task);
  const pins = settings.pins[task.type] ?? [];
  const [forcedAccount, forcedModel] = task.use ? splitUse(task.use) : [undefined, undefined];
  // a route changes how this task is ranked; it never loosens privacy or quota
  // an escalating task tries the cheap route first, and its stronger attempt names the deep route
  const routeName = task.route ?? (task.escalate ? 'cheap' : undefined);
  const via = routeName ? routeDef(routeName, settings) : undefined;
  const mode = via?.mode ?? settings.mode;
  const fast = !!(task.fast || via?.fast);

  const candidates: Candidate[] = [];
  // the quickest typical time seen, which a model's own typical time is compared with
  const fastest = fast ? Math.min(...Object.values(ctx.latency ?? {})) : Infinity;
  const rejected: Rejected[] = [];

  for (const account of ctx.config.accounts) {
    const reject = (reason: string, model?: string) => rejected.push({ accountId: account.id, model, reason });
    if (forcedAccount && account.id !== forcedAccount) continue;
    if (task.avoid?.includes(account.id)) { reject('avoided for this task'); continue; }
    // only a team account is held to the team's budgets, even when the developer has an account with the same id
    if (account.team && ctx.blocked?.[account.id]) { reject(ctx.blocked[account.id]!); continue; }
    if (task.textOnly && account.driver === 'cli') { reject('this task runs without tools, so agent CLIs are not used'); continue; }
    if (!account.enabled) { reject('disabled'); continue; }
    if (via?.use && !via.use.some((u) => u === account.id || u.startsWith(`${account.id}/`))) { reject(`not in route "${routeName}"`); continue; }
    if (via?.local && !(account.local && loopback(account.baseUrl))) { reject(`route "${routeName}": models on this computer only`); continue; }
    if (settings.bannedProviders.includes(account.provider)) { reject('provider is banned in settings'); continue; }

    const h = ctx.health[account.id];
    if (h && (h.state === 'auth_error' || h.state === 'disabled')) { reject(`${h.state}: ${h.reason ?? ''}`.trim()); continue; }
    if (h && (h.state === 'cooling' || h.state === 'exhausted' || h.state === 'offline') && (h.until ?? 0) > now) {
      reject(`${h.state} until ${new Date(h.until!).toLocaleTimeString()}`);
      continue;
    }

    if (task.type === 'code' && account.driver !== 'cli') {
      // an API model edits files through OpenCode, which omnitrix runs with this account's key and model
      if (account.driver !== 'openai') { reject('code tasks need an agent CLI that can edit files'); continue; }
      if (settings.apiCodeAgent === 'off') { reject('code tasks on API accounts are turned off (settings apiCodeAgent)'); continue; }
      if (!ctx.apiAgent) { reject('code tasks on an API account need OpenCode: install OpenCode (npm install -g opencode-ai) to let this account edit files'); continue; }
    }
    if (privacy === 'secret' && !(account.local && loopback(account.baseUrl))) { reject('secret task: local models only'); continue; }
    if (privacy === 'private' && settings.protectPrivate && account.trainsOnData) { reject('private task: this provider may train on prompts'); continue; }

    const usage = ctx.usage[account.id];
    const room = usage ? headroom(usage) : 0.8;
    if (room <= 0) { reject('no quota left in the current window'); continue; }

    const models = forcedModel ? account.models.filter((m) => m.id === forcedModel) : account.models;
    if (models.length === 0) { reject(forcedModel ? `model ${forcedModel} not on this account` : 'no models configured'); continue; }

    const busy = (ctx.running[account.id] ?? 0) >= account.concurrency;
    // only the API drivers attach pictures; an agent CLI would get the file name and nothing else
    if (task.type === 'vision' && account.driver !== 'openai' && account.driver !== 'anthropic') { reject('this account cannot send images'); continue; }

    for (const model of models) {
      if (task.avoid?.includes(`${account.id}/${model.id}`)) { reject('avoided for this task', model.id); continue; }
      if (via?.use && !via.use.includes(account.id) && !via.use.includes(`${account.id}/${model.id}`)) { reject(`not in route "${routeName}"`, model.id); continue; }
      // an agent edits files through tool calls, which this model cannot make
      if (task.type === 'code' && account.driver === 'openai' && model.tools === false) { reject('this model cannot call tools, so it cannot edit files', model.id); continue; }
      const paused = ctx.health[modelHealthKey(account.id, model.id)];
      if (paused && paused.state === 'cooling' && (paused.until ?? 0) > now) {
        reject(`paused until ${new Date(paused.until!).toLocaleTimeString()} (${paused.reason ?? 'not answering'})`, model.id);
        continue;
      }
      // a model that cut a long prompt before gets only prompts that fit what it read then
      const cut = ctx.health[contextLimitKey(account.id, model.id)];
      if (cut?.contextTokens && (cut.until ?? 0) > now && Math.round(task.prompt.length / 4) > cut.contextTokens) {
        reject(`this model reads only about ${cut.contextTokens.toLocaleString('en-US')} tokens of a prompt, and this task is longer${account.provider === 'ollama' ? ' (start Ollama with OLLAMA_CONTEXT_LENGTH set higher to give it more room)' : ''}`, model.id);
        continue;
      }
      // a model whose limit for a minute leaves no room for a useful answer cannot take the task
      const minute = ctx.health[minuteLimitKey(account.id, model.id)];
      if (answerRoom(minute, task.prompt.length + PROMPT_EXTRA_CHARS, answerTokens(task.size), now) < Math.min(MIN_ANSWER, answerTokens(task.size))) {
        reject(`this task is too large for this model's per-minute limit of ${minute!.minuteTokens!.toLocaleString('en-US')} tokens on this key`, model.id);
        continue;
      }
      // Ollama's "-cloud" models run on Ollama's servers, even through a local Ollama
      if (privacy === 'secret' && /[-:]cloud$/i.test(model.id)) { reject('secret task: this model runs in the cloud', model.id); continue; }
      if (task.type === 'vision' && account.local && !model.visionChecked && !model.pinned) { reject('the server has not reported that this model reads images', model.id); continue; }
      if (task.type === 'vision' && model.skills.vision < 5) { reject('model cannot read images', model.id); continue; }
      const why: string[] = [];
      const f = fit(model.skills, task.type);
      if (task.minFit !== undefined && f < task.minFit) { reject(`weaker at ${task.type} (fit ${f.toFixed(2)}) than the worker it would check`, model.id); continue; }
      let score = mode === 'quality' ? f * f : f;
      const basis = basisOf(model);
      why.push(`fit ${f.toFixed(2)}${basis === 'untested' ? ' (untested scores)' : basis === 'estimated' ? ' (estimated scores)' : ''}`);

      // an account with little quota left still qualifies, it just stops being the first pick
      const q = 0.4 + 0.6 * room;
      score *= q;
      // without a known limit, the share is an assumption (see headroom), not a reading
      why.push(usage?.percentUsed === undefined
        ? `no known limit (counted as ${(room * 100).toFixed(0)}% left)`
        : `quota ${(room * 100).toFixed(0)}% left${usage.source === 'measured' ? ' (measured)' : usage.source === 'estimated' ? ' (estimated)' : ''}`);

      const t = timing(usage, room, now);
      score *= t.factor;
      why.push(...t.why);

      // An account that may train on prompts can only take public work, so it gets public work first and
      // the other accounts keep their quota for private work. A known price leaves this to the cost factor.
      if (privacy === 'public' && account.trainsOnData && !account.local && unpriced(model) && mode !== 'quality') {
        score *= PUBLIC_ONLY_BONUS;
        why.push('takes public work only, so it goes first');
      }

      const c = costFactor(model, account, mode, task.type);
      score *= c;
      if (c < 1) why.push(`cost x${c.toFixed(2)}`);

      // verdicts saved before versions were recorded still count until the version has its own
      const exact = acceptanceFactor(ctx.stats, statsKey(model), task.type, now);
      const acc = exact.samples || !model.digest ? exact : acceptanceFactor(ctx.stats, model.id, task.type, now);
      score *= acc.factor;
      if (acc.samples) why.push(`past results x${acc.factor.toFixed(2)} (${acc.samples} rated)`);

      const size = account.local ? ctx.localSizes?.[`${account.id}/${model.id}`] : undefined;
      if (size && ctx.gpuBytes && size > ctx.gpuBytes) {
        score *= TOO_BIG_FOR_GPU;
        why.push(`about ${Math.round(size / 1024 ** 3)} GB, more than this computer's ${Math.round(ctx.gpuBytes / 1024 ** 3)} GB of GPU memory, so it runs mostly on the processor and slowly`);
      }

      // A fast task prefers models that answered quickly before: the quickest keeps its score and one ten
      // times slower loses about half. Without a typical time, the speed score stands in, a little below
      // the quickest measured model, since a guess should not beat a measurement.
      if (fast) {
        const typical = ctx.latency?.[`${account.id}/${model.id}`];
        const known = typical !== undefined && Number.isFinite(fastest);
        score *= known ? 0.5 + 0.5 * Math.min(1, fastest / typical) : 0.5 + 0.05 * Math.min(9, model.skills.speed);
        why.push(known ? `typical ${(typical / 1000).toFixed(typical < 10_000 ? 1 : 0).replace(/\.0$/, '')} s` : 'speed not measured yet');
      }

      if (busy) { score *= 0.5; why.push('busy, will queue'); }

      const pinIndex = pins.findIndex((p) => p === account.id || p === `${account.id}/${model.id}`);
      if (pinIndex >= 0) { score += 10 - pinIndex; why.push('pinned'); }

      // tiny tie-breaker so the order is stable
      score -= account.priority * 0.0001;
      candidates.push({ accountId: account.id, model: model.id, score, why });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return { candidates, rejected };
}

/** The longest answer omnitrix asks an API model for, by task size. */
export function answerTokens(size: TaskSpec['size']): number {
  return size === 'small' ? 4000 : size === 'large' ? 32000 : 16000;
}

/** Below this, an answer is too short to be worth asking a model for. */
const MIN_ANSWER = 1000;

/** What omnitrix adds to a task's prompt before sending it, such as its rules and the acceptance line, counted high. */
const PROMPT_EXTRA_CHARS = 2000;

/**
 * The longest answer that fits a model's token limit for a minute, once one is known: the limit itself when it
 * counts only the answer, else what the prompt leaves of it. Prompt tokens are counted high (three characters
 * each) and a tenth is kept free, so the request stays under the limit. It can be below MIN_ANSWER, or below 1.
 */
export function answerRoom(limit: AccountHealth | undefined, promptChars: number, wanted: number, now = Date.now()): number {
  if (!limit?.minuteTokens || (limit.until ?? 0) <= now) return wanted;
  const room = limit.minuteOutputOnly ? limit.minuteTokens : limit.minuteTokens - Math.ceil(promptChars / 3);
  return Math.min(wanted, Math.floor(room * 0.9));
}

/** Where the learned token limit for a minute of one model is kept in health.json, apart from its prompt size. */
export function minuteLimitKey(accountId: string, modelId: string): string {
  return `${modelHealthKey(accountId, modelId)}#minute`;
}

/** Where the learned prompt size of one model is kept in health.json. */
export function contextLimitKey(accountId: string, modelId: string): string {
  return `${modelHealthKey(accountId, modelId)}#context`;
}

/** Health entries for one model sit next to the account entries, keyed "account/model". */
export function modelHealthKey(accountId: string, modelId: string): string {
  return `${accountId}/${modelId}`;
}

export function splitUse(use: string): [string, string | undefined] {
  const i = use.indexOf('/');
  return i < 0 ? [use, undefined] : [use.slice(0, i), use.slice(i + 1)];
}
