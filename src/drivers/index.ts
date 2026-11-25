import type { Account, DriverRequest, DriverResult, ModelInfo } from '../types.js';
import { listAnthropicModels, runAnthropic } from './anthropic.js';
import { codexModels, runApiAgent, runCli } from './cli.js';
import { listOpenAIModels, runOpenAI } from './openai.js';
import { makeModel } from '../models.js';
import { loadConfig, updateConfig } from '../store.js';

export function runDriver(req: DriverRequest, edit = false): Promise<DriverResult> {
  switch (req.account.driver) {
    case 'openai':
      // a code task needs an agent that can edit files; the API alone only answers
      return edit ? runApiAgent(req) : runOpenAI(req);
    case 'anthropic':
      return runAnthropic(req);
    case 'cli':
      return runCli(req, edit);
  }
}

/**
 * Scores for the models Codex lists. The name gives the tier, as for any model; an older generation of
 * the same tier scores lower, one point within the same major version and two below it, so the router
 * does not pick last year's model over the current one with the same name.
 */
export function codexModelInfo(ids: string[]): ModelInfo[] {
  const version = (id: string) => {
    const m = /(\d+)(?:\.(\d+))?/.exec(id);
    return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0) } : undefined;
  };
  const newest = ids.map(version).filter((v): v is { major: number; minor: number } => !!v).sort((a, b) => b.major - a.major || b.minor - a.minor)[0];
  const QUALITY = ['coding', 'reasoning', 'writing', 'longContext'] as const;
  const gen = (id: string) => {
    const v = version(id);
    return v ? `${v.major}.${v.minor}` : id;
  };
  const newestGen = newest ? `${newest.major}.${newest.minor}` : undefined;
  // Codex lists a plan's models in its own order, its default first. The names say little about which of
  // two models of one generation is stronger, so within a generation the first one listed stays ahead, and
  // an older generation stays below the first model of the newest one.
  const leaders = new Map<string, ModelInfo>();
  return ids.map((id) => {
    const model = makeModel(id);
    const v = version(id);
    const drop = !newest || !v || (v.major === newest.major && v.minor === newest.minor) ? 0 : v.major === newest.major ? 1 : 2;
    if (drop) for (const k of QUALITY) model.skills[k] = Math.max(1, model.skills[k] - drop);
    const above = [leaders.get(gen(id)), gen(id) !== newestGen && newestGen ? leaders.get(newestGen) : undefined].filter((m): m is ModelInfo => !!m);
    for (const k of QUALITY) for (const m of above) model.skills[k] = Math.max(1, Math.min(model.skills[k], m.skills[k] - 1));
    if (!leaders.has(gen(id))) leaders.set(gen(id), model);
    return model;
  });
}

/**
 * A Codex account added before omnitrix could read Codex's model list has the one model "default", which
 * leaves the choice to Codex and gets plain untested scores. Once Codex has saved its list, such an
 * account gets the real models instead. Returns the ids of the accounts that changed.
 */
export function upgradeCodexModels(): string[] {
  const stale = (a: Account) => a.driver === 'cli' && a.provider === 'codex' && a.models.length === 1 && a.models[0]!.id === 'default' && !a.models[0]!.pinned;
  // Scores are saved when the list is read, so an update that ranks the models differently reaches an account
  // only when they are worked out again. Not when the user set any of them by hand.
  const outdated = (a: Account) => {
    if (a.driver !== 'cli' || a.provider !== 'codex' || a.models.some((m) => m.pinned || m.basis === 'manual')) return false;
    const fresh = codexModelInfo(a.models.map((m) => m.id));
    return a.models.some((m, i) => JSON.stringify(m.skills) !== JSON.stringify(fresh[i]!.skills));
  };
  if (!loadConfig().accounts.some((a) => (stale(a) && codexModels(a).length) || outdated(a))) return [];
  return updateConfig((cfg) => {
    const changed: string[] = [];
    for (const a of cfg.accounts) {
      const ids = stale(a) ? codexModels(a) : [];
      if (ids.length) a.models = codexModelInfo(ids);
      else if (outdated(a)) {
        const fresh = codexModelInfo(a.models.map((m) => m.id));
        a.models.forEach((m, i) => (m.skills = fresh[i]!.skills));
      } else continue;
      changed.push(a.id);
    }
    return changed;
  });
}

/** Ask the provider which models it has. Of the CLI tools, only Codex keeps such a list. */
export async function discoverModels(account: Account): Promise<string[]> {
  if (account.driver === 'openai') return listOpenAIModels(account);
  if (account.driver === 'anthropic') return listAnthropicModels(account);
  if (account.driver === 'cli' && account.provider === 'codex') return codexModels(account);
  return [];
}
