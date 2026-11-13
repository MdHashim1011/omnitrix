// Picks the account and model for a task. Hard rules go first (privacy, health, quota, what the driver
// can do); whatever is left gets a score, and the highest score gets the task.
import { acceptanceFactor } from './stats.js';
import { headroom, roughSpan, type UsageSummary } from './usage.js';
import type { Account, AccountHealth, Config, ModelInfo, Privacy, Skills, TaskSpec, TaskType } from './types.js';

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

  const candidates: Candidate[] = [];
  const rejected: Rejected[] = [];

  for (const account of ctx.config.accounts) {
    const reject = (reason: string, model?: string) => rejected.push({ accountId: account.id, model, reason });
    if (forcedAccount && account.id !== forcedAccount) continue;
    if (!account.enabled) { reject('disabled'); continue; }
    if (settings.bannedProviders.includes(account.provider)) { reject('provider is banned in settings'); continue; }

    const h = ctx.health[account.id];
    if (h && (h.state === 'auth_error' || h.state === 'disabled')) { reject(`${h.state}: ${h.reason ?? ''}`.trim()); continue; }
    if (h && (h.state === 'cooling' || h.state === 'exhausted' || h.state === 'offline') && (h.until ?? 0) > now) {
      reject(`${h.state} until ${new Date(h.until!).toLocaleTimeString()}`);
      continue;
    }

    if (task.type === 'code' && account.driver !== 'cli') { reject('code tasks need an agent CLI that can edit files'); continue; }
    if (privacy === 'secret' && !account.local) { reject('secret task: local models only'); continue; }
    if (privacy === 'private' && settings.protectPrivate && account.trainsOnData) { reject('private task: this provider may train on prompts'); continue; }

    const usage = ctx.usage[account.id];
    const room = usage ? headroom(usage) : 0.8;
    if (room <= 0) { reject('no quota left in the current window'); continue; }

    const models = forcedModel ? account.models.filter((m) => m.id === forcedModel) : account.models;
    if (models.length === 0) { reject(forcedModel ? `model ${forcedModel} not on this account` : 'no models configured'); continue; }

    const busy = (ctx.running[account.id] ?? 0) >= account.concurrency;

    for (const model of models) {
      const paused = ctx.health[modelHealthKey(account.id, model.id)];
      if (paused && paused.state === 'cooling' && (paused.until ?? 0) > now) {
        reject(`paused until ${new Date(paused.until!).toLocaleTimeString()} (${paused.reason ?? 'not answering'})`, model.id);
        continue;
      }
      if (task.type === 'vision' && model.skills.vision < 5) { reject('model cannot read images', model.id); continue; }
      const why: string[] = [];
      const f = fit(model.skills, task.type);
      let score = settings.mode === 'quality' ? f * f : f;
      why.push(`fit ${f.toFixed(2)}`);

      // an account with little quota left still qualifies, it just stops being the first pick
      const q = 0.4 + 0.6 * room;
      score *= q;
      why.push(`quota ${(room * 100).toFixed(0)}% left${usage?.source === 'measured' ? ' (measured)' : usage?.source === 'estimated' ? ' (estimated)' : ''}`);

      const t = timing(usage, room, now);
      score *= t.factor;
      why.push(...t.why);

      // An account that may train on prompts can only take public work, so it gets public work first and
      // the other accounts keep their quota for private work. A known price leaves this to the cost factor.
      if (privacy === 'public' && account.trainsOnData && !account.local && unpriced(model) && settings.mode !== 'quality') {
        score *= PUBLIC_ONLY_BONUS;
        why.push('takes public work only, so it goes first');
      }

      const c = costFactor(model, account, settings.mode, task.type);
      score *= c;
      if (c < 1) why.push(`cost x${c.toFixed(2)}`);

      const acc = acceptanceFactor(ctx.stats, model.id, task.type, now);
      score *= acc.factor;
      if (acc.samples) why.push(`past results x${acc.factor.toFixed(2)} (${acc.samples})`);

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

/** Health entries for one model sit next to the account entries, keyed "account/model". */
export function modelHealthKey(accountId: string, modelId: string): string {
  return `${accountId}/${modelId}`;
}

export function splitUse(use: string): [string, string | undefined] {
  const i = use.indexOf('/');
  return i < 0 ? [use, undefined] : [use.slice(0, i), use.slice(i + 1)];
}
