#!/usr/bin/env node
// The omnitrix command line: add and manage accounts, check usage, and wire omnitrix into Claude Code.
// It reads and writes the same files in ~/.omnitrix that the MCP server uses.
import { Command, Option } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveDashboard } from './dashboard.js';
import { DEFAULT_PORT, ensureDashboard, stopDashboard } from './dashboard-launch.js';
import { discoverModels, runDriver } from './drivers/index.js';
import { CLI_TOOLS, loginCli, providerTool, resolveCommand } from './drivers/cli.js';
import { Engine } from './engine.js';
import { verifySummary } from './verify.js';
import { describeAccount } from './mcp.js';
import { localModels } from './drivers/ollama.js';
import { basisOf, isChatModel, makeModel, statsKey } from './models.js';
import { loadStats } from './stats.js';
import { PROVIDERS, getProvider } from './providers.js';
import { renderStatusLine } from './statusline.js';
import { deleteSecret, dropModel, ensureHome, files, findAccount, homeDir, inside, JOB_ID, loadConfig, loadHealth, updateConfig, readJson, redact, saveConfig, saveHealth, setSecret, uniqueAccountId } from './store.js';
import { branchExists, branchMerged, deleteBranch, pruneWorktree } from './worktree.js';
import { EFFORTS, DriverError, TASK_TYPES, type Account, type Config, type Job, type Limits, type ModelInfo, type TaskType, type UsageRecord } from './types.js';
import { refreshQuotas } from './quota.js';
import { formatTokens, readLedger, recordUsage, typicalLatency } from './usage.js';
import { describeDelegated } from './value.js';
import { checkLockfiles, describeLock } from './lockfile.js';
import { ownerAlive } from './owner.js';
import { claudeProjectsDir, formatOverhead, measureOverhead, resultTokens } from './overhead.js';

/** The job records created since the given time, for report and overhead. */
function jobsSince(since: number): Job[] {
  const jobs: Job[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(files.jobs()).filter((f) => f.endsWith('.json'));
  } catch {
    // no jobs yet
  }
  for (const name of names) {
    const j = readJson<Job | null>(path.join(files.jobs(), name), null);
    if (j && typeof j.createdAt === 'number' && j.createdAt >= since && j.task && Array.isArray(j.attempts)) jobs.push(j);
  }
  return jobs;
}

/** A typical answer time as people read it: "4.2 s", "38 s", or "-" when there is none yet. */
function seconds(ms: number | undefined): string {
  // the same form as the router's "typical 4.2 s"
  return ms === undefined ? '-' : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(/\.0$/, '')} s`;
}
import { detect } from './init.js';
import { budgetFor, estimateCost, fingerprint, loadTeam, officialHost, parseTeam, periodStart, personSpend, readShared, reviewCode, shareRecord, teamAccounts, unpricedModels, type TeamFile } from './team.js';
import { buildReport, formatReport } from './report.js';
import { driftHint } from './drift.js';
import { VERSION } from './version.js';

const program = new Command();
program.name('omnitrix').description('One Claude brain, every AI account you have.').version(VERSION);

/** Report a failure after network work without calling process.exit: exiting while a connection is still
 *  closing trips a libuv assertion on Windows (UV_HANDLE_CLOSING). Node exits once its handles are done. */
function fail(msg: string): void {
  process.stderr.write(`error: ${msg}
`);
  process.exitCode = 1;
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

/** Team accounts come from the team file; a local change would be lost on the next load, so refuse it. */
function ownAccount(cfg: Config, id: string): Account {
  const acc = findAccount(cfg, id) ?? die(`no account "${id}"`);
  if (acc.team) die(`${id} is managed by the team file ${cfg.settings.team?.file ?? ''}; change it there`);
  return acc;
}

function int(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a number: ${v}`);
  return n;
}

function limitOptions(cmd: Command): Command {
  return cmd
    .option('--rpm <n>', 'requests per minute limit', int)
    .option('--r5h <n>', 'requests per 5 hours limit', int)
    .option('--rpd <n>', 'requests per day limit', int)
    .option('--rpw <n>', 'requests per week limit', int)
    .option('--tpd <n>', 'tokens per day limit', int)
    .option('--tpm <n>', 'tokens per month limit', int);
}

function limitsFrom(o: Record<string, any>, base: Limits = {}): Limits {
  const l = { ...base };
  if (o.rpm !== undefined) l.requestsPerMinute = o.rpm;
  if (o.r5h !== undefined) l.requestsPer5h = o.r5h;
  if (o.rpd !== undefined) l.requestsPerDay = o.rpd;
  if (o.rpw !== undefined) l.requestsPerWeek = o.rpw;
  if (o.tpd !== undefined) l.tokensPerDay = o.tpd;
  if (o.tpm !== undefined) l.tokensPerMonth = o.tpm;
  return l;
}

program
  .command('providers')
  .description('list the providers you can connect')
  .option('--free', 'only providers with a free tier or free allowance, and local ones')
  .action((o: { free?: boolean }) => {
    const groups: [string, (p: (typeof PROVIDERS)[number]) => boolean][] = [
      ['Agent CLIs (sign in with a subscription, can edit files)', (p) => p.driver === 'cli'],
      ['Hosted APIs', (p) => p.driver !== 'cli' && !p.local && !p.id.startsWith('custom')],
      ['On your own machine', (p) => !!p.local],
      ['Anything else', (p) => p.id.startsWith('custom')],
    ];
    for (const [title, test] of groups) {
      const shown = PROVIDERS.filter(test).filter((p) => !o.free || p.free || p.local);
      if (!shown.length) continue;
      console.log(`\n${title}`);
      for (const p of shown) {
        const pad = `\n  ${''.padEnd(17)} `;
        console.log(`  ${p.id.padEnd(17)} ${p.name}${p.tested ? ` (tested with a real account, ${p.tested})` : ''}${p.signup ? `${pad}${p.signup}` : ''}${p.note ? `${pad}${p.note}` : ''}`);
      }
    }
    console.log('\nOnly the providers marked as tested were run with a real account; the others are covered by the automated tests.');
    console.log('Add one with: omnitrix add <provider> --key-env NAME   (or --key, --base-url, --model)');
  });

limitOptions(
  program
    .command('add <provider>')
    .description('connect an account (API key, subscription CLI or local model)')
    .option('--label <text>', 'display name, e.g. "Hashim ChatGPT Plus"')
    .option('--owner <name>', 'who owns this account', 'me')
    .option('--id <id>', 'account id (default: made from the label)')
    .option('--key <value>', 'API key, saved in the omnitrix secrets file')
    .option('--key-env <NAME>', 'read the API key from this environment variable instead of saving it')
    .option('--base-url <url>', 'API base URL (needed for custom providers)')
    .option('--anthropic', 'use the provider\'s Anthropic-compatible endpoint')
    .option('--model <ids>', 'comma separated model ids (skips auto-discovery)')
    .option('--concurrency <n>', 'jobs at the same time on this account', int)
    .option('--trains-on-data', 'mark that this provider may train on your prompts')
    .option('--no-trains-on-data', 'mark that this provider does not train on your prompts')
    .option('--login', 'for CLI accounts: sign in right away'),
).action(addAccount);

/** Shared by `add` and `init --apply`, so both connect an account in exactly the same way. */
async function addAccount(providerId: string, o: Record<string, any>): Promise<void> {
  const spec = getProvider(providerId);
  if (!spec) die(`unknown provider "${providerId}". Run "omnitrix providers".`);
  if (o.key && o.keyEnv) die('use either --key or --key-env, not both');
  ensureHome();
  const cfg = loadConfig();
  const label = o.label ?? spec.name;
  const id = o.id ? uniqueAccountId(cfg, o.id) : uniqueAccountId(cfg, label === spec.name ? spec.id : label);

  let driver = spec.driver;
  let baseUrl: string | undefined = o.baseUrl ?? spec.baseUrl;
  if (o.anthropic) {
    if (!spec.anthropicUrl && !o.baseUrl) die(`${spec.id} has no known Anthropic endpoint; pass --base-url`);
    driver = 'anthropic';
    baseUrl = o.baseUrl ?? spec.anthropicUrl;
  }
  if (driver !== 'cli' && !baseUrl) die(spec.baseUrlHint ? `this provider needs --base-url ${spec.baseUrlHint}` : 'this provider needs --base-url');
  if (driver === 'cli' && o.baseUrl) baseUrl = o.baseUrl;
  else if (driver === 'cli') baseUrl = undefined;

  let apiKey: string | undefined;
  if (o.keyEnv) apiKey = `env:${o.keyEnv}`;
  else if (o.key) apiKey = 'secret';
  // a key already sitting in the usual environment variable is used without asking (also by CLIs that need one)
  else if (spec.keyEnv && process.env[spec.keyEnv]) apiKey = `env:${spec.keyEnv}`;
  if (!apiKey && driver !== 'cli' && !spec.local) die(`an API key is needed: --key-env ${spec.keyEnv ?? 'NAME'} or --key <value>`);

  const account: Account = {
    id,
    label,
    owner: o.owner,
    provider: spec.id,
    driver,
    baseUrl,
    apiKey,
    models: [],
    limits: limitsFrom(o, spec.limits ?? {}),
    concurrency: o.concurrency ?? (driver === 'cli' ? 1 : spec.local ? 1 : 2),
    enabled: true,
    trainsOnData: o.trainsOnData ?? !!spec.trainsOnData,
    local: !!spec.local,
    priority: cfg.accounts.length,
    addedAt: new Date().toISOString(),
  };
  if (o.key) setSecret(id, o.key);

  if (driver === 'cli') {
    const tool = CLI_TOOLS[providerTool(spec.id)];
    account.profileDir = path.join(files.profiles(), id);
    fs.mkdirSync(account.profileDir, { recursive: true });
    tool?.initProfile?.(account.profileDir);
    if (tool && !resolveCommand(tool.command)) console.log(`note: "${tool.command}" is not installed yet. Install it, then run: omnitrix login ${id}`);
  }

  if (o.model) {
    account.models = String(o.model).split(',').map((s) => s.trim()).filter(Boolean).map((m) => makeModel(m));
  } else if (driver === 'cli') {
    account.models = [makeModel('default')];
  } else {
    try {
      const found = (await discoverModels(account)).filter(isChatModel);
      account.models = await modelsFor(account, found.slice(0, 200));
      console.log(`found ${found.length} models`);
    } catch (err) {
      console.log(`could not list models (${err instanceof Error ? redact(err.message) : err})`);
    }
    if (!account.models.length && spec.models?.length) account.models = spec.models.map((m) => makeModel(m));
    if (!account.models.length) {
      if (o.key) deleteSecret(id);
      fail('no models found; pass them with --model id1,id2');
      return;
    }
  }

  updateConfig((latest) => {
    // another command may have added an account with this id while this one asked the provider
    if (findAccount(latest, id)) die(`an account "${id}" was added meanwhile; run the command again`);
    latest.accounts.push(account);
  });
  console.log(`added ${id} (${spec.name}, ${account.models.length} model${account.models.length === 1 ? '' : 's'}, owner ${account.owner})`);
  if (spec.note) console.log(`note: ${spec.note}`);
  if (account.owner !== 'me' && (spec.id === 'claude-code' || spec.id === 'antigravity')) {
    console.log('warning: Anthropic and Google do not allow letting other people use an account. Use accounts you own.');
  }
  if (driver === 'cli') {
    if (o.login) {
      const code = loginCli(account);
      if (code !== 0) console.log(`login exited with code ${code}; try again with: omnitrix login ${id}`);
    } else if (!account.apiKey) {
      // each CLI account has its own empty profile, so it must sign in once before it can run jobs
      console.log(`next: omnitrix login ${id}`);
    }
  }
  console.log(`check it with: omnitrix test ${id}`);
}

program
  .command('login <id>')
  .description('sign in a CLI account inside its own profile folder')
  .action((id: string) => {
    const acc = findAccount(loadConfig(), id) ?? die(`no account "${id}"`);
    if (acc.driver !== 'cli') die(`${id} uses an API key; nothing to sign in`);
    try {
      process.exit(loginCli(acc));
    } catch (err) {
      die(err instanceof Error ? err.message : String(err));
    }
  });

program
  .command('list')
  .alias('status')
  .description('show all accounts with usage and what is left')
  .option('--json', 'print JSON')
  .action(async (o) => {
    await refreshQuotas(loadConfig().accounts, 60_000, 5_000);
    const pool = new Engine().pool();
    if (o.json) return console.log(JSON.stringify(pool, null, 2));
    if (!pool.length) return console.log('no accounts yet. Start with: omnitrix providers');
    const ready = pool.filter((a) => a.state === 'ready' || a.state === 'busy').length;
    console.log(`${ready}/${pool.length} accounts available   (data: ${homeDir()})\n`);
    for (const a of pool) console.log(describeAccount(a));
  });

limitOptions(
  program
    .command('set <id>')
    .description('change an account: label, owner, limits, concurrency, priority')
    .option('--label <text>')
    .option('--owner <name>')
    .option('--concurrency <n>', 'jobs at the same time', int)
    .option('--priority <n>', 'lower is preferred when scores tie', int)
    .option('--trains-on-data')
    .option('--no-trains-on-data')
    .option('--key <value>')
    .option('--key-env <NAME>')
    .option('--base-url <url>'),
).action((id: string, o: Record<string, any>) => {
  updateConfig((cfg) => {
    const acc = ownAccount(cfg, id);
    if (o.label) acc.label = o.label;
    if (o.owner) acc.owner = o.owner;
    if (o.concurrency !== undefined) acc.concurrency = Math.max(1, o.concurrency);
    if (o.priority !== undefined) acc.priority = o.priority;
    if (o.trainsOnData !== undefined) acc.trainsOnData = o.trainsOnData;
    if (o.baseUrl) acc.baseUrl = o.baseUrl;
    if (o.key) {
      setSecret(id, o.key);
      acc.apiKey = 'secret';
    } else if (o.keyEnv) {
      deleteSecret(id);
      acc.apiKey = `env:${o.keyEnv}`;
    }
    acc.limits = limitsFrom(o, acc.limits);
  });
  if (o.key || o.keyEnv) saveHealth({ [id]: { state: 'ready' } });
  console.log(`updated ${id}`);
});

for (const [name, value] of [['enable', true], ['disable', false]] as const) {
  program
    .command(`${name} <id>`)
    .description(`${name} an account`)
    .action((id: string) => {
      updateConfig((cfg) => {
        ownAccount(cfg, id).enabled = value;
      });
      if (value) saveHealth({ [id]: { state: 'ready' } });
      console.log(`${id} ${value ? 'enabled' : 'disabled'}`);
    });
}

program
  .command('remove <id>')
  .description('remove an account (its CLI profile folder is kept unless --purge)')
  .option('--purge', 'also delete the profile folder with the saved login')
  .action((id: string, o) => {
    const acc = updateConfig((cfg) => {
      const found = ownAccount(cfg, id);
      cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
      return found;
    });
    deleteSecret(id);
    if (o.purge && acc.profileDir) fs.rmSync(acc.profileDir, { recursive: true, force: true });
    console.log(`removed ${id}${acc.profileDir && !o.purge ? ` (profile kept at ${acc.profileDir})` : ''}`);
  });

/** Model entries for an account: local servers describe their own models, others are scored from the name. */
async function modelsFor(account: Account, ids: string[]): Promise<ModelInfo[]> {
  if (account.provider === 'ollama' && account.baseUrl) return localModels(account.baseUrl, ids);
  return ids.map((m) => makeModel(m, {}, { local: account.local }));
}

program
  .command('models <id>')
  .description('show an account\'s models and their skill scores')
  .option('--refresh', 'ask the provider for its current model list')
  .action(async (id: string, o) => {
    let acc = o.refresh ? ownAccount(loadConfig(), id) : findAccount(loadConfig(), id) ?? die(`no account "${id}"`);
    if (o.refresh) {
      const found = (await discoverModels(acc)).filter(isChatModel);
      if (!found.length) die('the provider returned no models');
      const fresh = await modelsFor(acc, found);
      acc = updateConfig((cfg) => {
        const latest = ownAccount(cfg, id);
        const old = new Map(latest.models.map((m) => [m.id, m]));
        // scores set by hand stay; guesses are made again, with what the server now reports
        latest.models = fresh.map((m) => {
          const before = old.get(m.id);
          if (before?.pinned) return { ...before, digest: m.digest ?? before.digest };
          return { ...m, inputPrice: before?.inputPrice, outputPrice: before?.outputPrice };
        });
        return latest;
      });
      console.log(`now ${acc.models.length} models`);
    }
    const stats = loadStats();
    // the name column fits the longest name, so a long one never runs into the scores
    const width = Math.max(44, ...acc.models.map((m) => m.id.length + 2));
    // typical answer time from this computer's usage, so a user can see which models are quick
    const typical = typicalLatency(readLedger(Date.now() - 31 * 24 * 3600_000));
    console.log('model'.padEnd(width) + 'code reas writ long vis  speed  typical  scores     Claude accepted');
    for (const m of acc.models) {
      const s = m.skills;
      // verdicts fade over 30 days, so the counts are rounded
      let ok = 0;
      let all = 0;
      for (const [k, c] of Object.entries(stats)) {
        if (!k.startsWith(`${statsKey(m)}|`)) continue;
        ok += c.ok;
        all += c.ok + c.bad;
      }
      const rated = Math.round(all) ? `${Math.round(ok)} of ${Math.round(all)} rated jobs` : 'no rated jobs';
      console.log(`${m.id.padEnd(width)}${[s.coding, s.reasoning, s.writing, s.longContext, s.vision, s.speed].map((n) => String(n).padEnd(5)).join('')}  ${seconds(typical[`${acc.id}/${m.id}`]).padEnd(9)}${basisOf(m).padEnd(11)}${rated}`);
    }
    console.log('\nScores: "untested" means no information, "estimated" a guess from the name or from what the server reports, "manual" set with "omnitrix model".');
    console.log('They are starting points; the router also follows how often Claude accepted each model\'s work.');
  });

program
  .command('model <id> <model>')
  .description('set skill scores (0-10) or prices for one model, or add/remove it')
  .option('--coding <n>', '', int)
  .option('--reasoning <n>', '', int)
  .option('--writing <n>', '', int)
  .option('--long-context <n>', '', int)
  .option('--vision <n>', '', int)
  .option('--speed <n>', '', int)
  .option('--input-price <usd>', 'USD per million input tokens', parseFloat)
  .option('--output-price <usd>', 'USD per million output tokens', parseFloat)
  .option('--add', 'add this model to the account')
  .option('--remove', 'remove this model from the account')
  .action((id: string, modelId: string, o: Record<string, any>) => {
    if (o.remove) {
      updateConfig((cfg) => {
        const acc = ownAccount(cfg, id);
        acc.models = acc.models.filter((m) => m.id !== modelId);
      });
      return console.log(`removed ${modelId} from ${id}`);
    }
    const m = updateConfig((cfg) => {
      const acc = ownAccount(cfg, id);
      let m = acc.models.find((x) => x.id === modelId);
      if (!m) {
        if (!o.add) die(`${id} has no model "${modelId}" (use --add)`);
        // a model added by hand to a local account follows the local rules: its name proves nothing
        m = makeModel(modelId, {}, { local: acc.local });
        acc.models.push(m);
      }
      const clamp = (n: number) => Math.max(0, Math.min(10, n));
      const map: Record<string, keyof typeof m.skills> = { coding: 'coding', reasoning: 'reasoning', writing: 'writing', longContext: 'longContext', vision: 'vision', speed: 'speed' };
      let touched = false;
      for (const [opt, skill] of Object.entries(map)) {
        if (o[opt] !== undefined) {
          m.skills[skill] = clamp(o[opt]);
          touched = true;
        }
      }
      if (touched) {
        m.pinned = true;
        m.basis = 'manual';
      }
      // a person who sets a vision score vouches for it, on any server
      if (o.vision !== undefined) m.visionChecked = true;
      if (o.inputPrice !== undefined) m.inputPrice = o.inputPrice;
      if (o.outputPrice !== undefined) m.outputPrice = o.outputPrice;
      return m;
    });
    console.log(`${id}/${modelId}: ${JSON.stringify(m.skills)}`);
  });

/** Sends a tiny request to one account, trying its models in order; true when one answered. */
async function testAccount(id: string, o: { model?: string }): Promise<boolean> {
  const cfg = loadConfig();
  const acc = findAccount(cfg, id);
  if (!acc) {
    fail(`no account "${id}"`);
    return false;
  }
  // try the listed models in order until one answers; a provider may still list models it has retired
  // a code-completion or scoring model in the list would fail a chat test for reasons of its own
  const chat = acc.models.map((m) => m.id).filter(isChatModel);
  const queue = o.model ? [o.model] : chat.length ? chat : acc.models.length ? acc.models.map((m) => m.id) : ['default'];
  for (const model of queue) {
    const t0 = Date.now();
    process.stdout.write(`testing ${id}/${model} ... `);
    try {
      const r = await runDriver({ account: acc, model, prompt: 'Reply with the single word OK.', timeoutMs: 180_000, maxOutputTokens: 64 });
      const ms = Date.now() - t0;
      // an empty answer means the model cannot do chat work as it is, so it is not counted as a success
      if (!r.text.trim()) {
        console.log(`answered in ${(ms / 1000).toFixed(1)}s, but the answer was empty`);
        if (!o.model) continue;
        fail(`${model} gave an empty answer; it may need more output room, or it may not suit chat tasks`);
        return false;
      }
      const costUsd = r.costUsd ?? estimateCost(acc.models.find((m) => m.id === model), r.inputTokens, r.outputTokens);
      const rec = { ts: Date.now(), accountId: id, model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ok: true, latencyMs: ms, costUsd };
      // a test on a team account spends the team's money like any other request
      const team = acc.team && cfg.settings.team ? loadTeam(cfg.settings.team) : undefined;
      const tagged = team?.team ? { ...rec, user: team.membership.user, team: team.team.name } : rec;
      recordUsage(tagged);
      if (team?.team?.auditDir) shareRecord(team.team.auditDir, team.membership.user, tagged);
      saveHealth({ [id]: { state: 'ready', measured: r.rate ? { ...r.rate, at: Date.now(), source: 'response headers' } : undefined } });
      console.log(`ok in ${(ms / 1000).toFixed(1)}s: "${r.text.trim().slice(0, 60)}"`);
      if (r.rate?.remainingRequests !== undefined) console.log(`provider says ${r.rate.remainingRequests} requests left in this window`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('failed');
      if (err instanceof DriverError && err.kind === 'model_gone' && !o.model) {
        dropModel(id, model);
        console.log(`  ${model} is no longer available, so it was removed from ${id}; trying the next model`);
        continue;
      }
      if (err instanceof DriverError && err.kind === 'auth') saveHealth({ [id]: { state: 'auth_error', reason: msg.slice(0, 160) } });
      fail(redact(msg));
      return false;
    }
  }
  fail(`no model on ${id} answered`);
  return false;
}

program
  .command('test [id]')
  .description('send a tiny request to check that an account works; --all checks every enabled account')
  .option('--model <id>')
  .option('--all', 'check every enabled account, one after another, and exit with 1 when any fails')
  .action(async (id: string | undefined, o: { model?: string; all?: boolean }) => {
    if (!id === !o.all) die('name an account, or use --all');
    if (o.all && o.model) die('--model names a model of one account; leave it out with --all');
    if (id) {
      await testAccount(id, o);
      return;
    }
    const ids = loadConfig().accounts.filter((a) => a.enabled).map((a) => a.id);
    const failed: string[] = [];
    for (const each of ids) if (!(await testAccount(each, o))) failed.push(each);
    console.log(`${ids.length - failed.length} of ${ids.length} accounts answered${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
    // a failed account has already set the exit code to 1
  });

program
  .command('run <prompt...>')
  .description('send one task through the router and print the answer')
  .addOption(new Option('--type <type>', 'task type').choices([...TASK_TYPES]).default('writing'))
  .addOption(new Option('--privacy <level>').choices(['public', 'private', 'secret']))
  .option('--use <account[/model]>', 'force an account or model')
  .addOption(new Option('--effort <level>', 'how hard a reasoning model should think').choices([...EFFORTS]))
  .option('--repo <path>', 'git repo for code tasks')
  .option('--fast', 'prefer models that answered quickly before')
  .action(async (words: string[], o) => {
    const engine = new Engine();
    const prompt = words.join(' ');
    const [job] = engine.dispatch([{ title: prompt.slice(0, 60), type: o.type as TaskType, prompt, privacy: o.privacy, use: o.use, effort: o.effort, fast: o.fast, repo: o.repo ? path.resolve(o.repo) : undefined }]);
    // wait a moment first so the chosen account is printed before the answer arrives
    let done = await engine.wait([job!.id], 1);
    if (done[0]?.accountId) process.stderr.write(`-> ${done[0].accountId}/${done[0].model}\n`);
    while (done[0] && (done[0].status === 'queued' || done[0].status === 'running')) done = await engine.wait([job!.id], 30);
    const j = done[0]!;
    if (j.status !== 'done') {
      fail(j.error ?? j.status);
      return;
    }
    process.stderr.write(`(${j.accountId}/${j.model}, ${(j.usage?.inputTokens ?? 0) + (j.usage?.outputTokens ?? 0)} tokens)\n`);
    console.log(engine.readOutput(j.id) ?? j.preview);
    // no process.exit here: exiting while a connection is still closing crashes Node on Windows
  });

program
  .command('route <prompt...>')
  .description('show which account and model would get a task, without running it')
  .addOption(new Option('--type <type>', 'task type').choices([...TASK_TYPES]).default('writing'))
  .addOption(new Option('--privacy <level>').choices(['public', 'private', 'secret']))
  .option('--fast', 'prefer models that answered quickly before')
  .action((words: string[], o) => {
    const { candidates, rejected } = new Engine().preview({ title: 'preview', type: o.type, prompt: words.join(' '), privacy: o.privacy, fast: o.fast });
    if (!candidates.length) console.log('nobody can take this task');
    const shown = candidates.slice(0, 8);
    const width = Math.max(46, ...shown.map((c) => `${c.accountId}/${c.model}`.length));
    shown.forEach((c, i) => console.log(`${String(i + 1).padStart(2)}. ${`${c.accountId}/${c.model}`.padEnd(width)} ${c.score.toFixed(3)}  ${c.why.join(', ')}`));
    if (rejected.length) {
      console.log('\nskipped:');
      for (const r of rejected.slice(0, 12)) console.log(`    ${r.accountId}${r.model ? '/' + r.model : ''}: ${r.reason}`);
    }
  });

program
  .command('settings')
  .description('show or change global settings')
  .addOption(new Option('--mode <mode>', 'balanced, quality (best model) or saver (cheapest)').choices(['balanced', 'quality', 'saver']))
  .addOption(new Option('--protect-private <on|off>', 'keep private tasks away from providers that train on data').choices(['on', 'off']))
  .option('--ban <provider>', 'never use this provider')
  .option('--unban <provider>')
  .option('--pin <type=account[/model],...>', 'always try these first for a task type, e.g. code=codex-main')
  .option('--unpin <type>')
  .option('--timeout <seconds>', 'job timeout', int)
  .option('--preview-chars <n>', 'how much of each result Claude sees', int)
  .action((o) => {
    const s = updateConfig((cfg) => {
      const s = cfg.settings;
      if (o.mode) s.mode = o.mode;
      if (o.protectPrivate) s.protectPrivate = o.protectPrivate === 'on';
      if (o.ban && !s.bannedProviders.includes(o.ban)) s.bannedProviders.push(o.ban);
      if (o.unban) s.bannedProviders = s.bannedProviders.filter((p) => p !== o.unban);
      if (o.pin) {
        const [type, list] = String(o.pin).split('=');
        if (!type || !list || !(TASK_TYPES as readonly string[]).includes(type)) die('use --pin type=account[/model],... with a valid task type');
        s.pins[type as TaskType] = list.split(',').map((x) => x.trim()).filter(Boolean);
      }
      if (o.unpin) delete s.pins[o.unpin as TaskType];
      if (o.timeout) s.jobTimeoutSec = o.timeout;
      if (o.previewChars) s.resultPreviewChars = o.previewChars;
      return s;
    });
    console.log(JSON.stringify(s, null, 2));
  });

program
  .command('statusline')
  .description('one-line pool summary for the Claude Code status line (reads Claude\'s JSON on stdin)')
  .action(async () => {
    let input = '';
    if (!process.stdin.isTTY) {
      input = await new Promise<string>((resolve) => {
        let data = '';
        const t = setTimeout(() => resolve(data), 250);
        process.stdin.on('data', (d) => (data += d));
        process.stdin.on('end', () => {
          clearTimeout(t);
          resolve(data);
        });
      });
    }
    process.stdout.write(renderStatusLine(input) + '\n');
    process.exit(0);
  });

program
  .command('dashboard')
  .description('open the live dashboard; it keeps running in the background')
  .option('--port <n>', 'port', int, DEFAULT_PORT)
  .option('--no-open', 'do not open a browser tab')
  .option('--stop', 'stop the background dashboard')
  .option('--serve', 'run the dashboard in this terminal until Ctrl+C')
  .action(async (o) => {
    if (o.stop) return console.log((await stopDashboard(o.port)) ? 'dashboard stopped' : 'no dashboard was running');
    if (o.serve) return serveDashboard(o.port);
    await showDashboard(o.port, o.open);
  });

/** Start or find the background dashboard and open it, unless a tab is already open. */
async function showDashboard(port: number, open: boolean, onlyToLook = false): Promise<void> {
  // test runs and CI machines have no one to look at a browser
  const quiet = !open || process.env.OMNITRIX_NO_BROWSER === '1' || !!process.env.CI;
  // after setup the dashboard is for looking at; with nobody to look, it is not started
  if (quiet && onlyToLook) return console.log('See everything live with "omnitrix dashboard".');
  const d = await ensureDashboard({ port, open: quiet ? false : undefined });
  console.log(`dashboard: ${d.url}${d.started ? ' (started in the background; stop it with "omnitrix dashboard --stop")' : ''}${d.opened ? '' : quiet ? '' : ' (already open in a browser tab)'}`);
}

program
  .command('mcp')
  .description('run the MCP server (Claude Code starts this for you)')
  .action(async () => {
    const { startMcp } = await import('./mcp.js');
    startMcp();
  });

program
  .command('init')
  .description('find AI tools, API keys and local models on this computer and connect them')
  .option('--apply', 'connect what was found; without it, nothing is changed')
  .option('--no-open', 'do not open the dashboard afterwards')
  .action(async (o) => {
    // looking changes nothing; addAccount creates the data folder when something is connected
    const found = await detect(loadConfig());
    // only --apply starts anything; looking, as the first step is described, changes nothing at all
    const dashboard = async () => {
      if (o.apply) await showDashboard(DEFAULT_PORT, o.open, true).catch((err) => console.log(`could not open the dashboard: ${err instanceof Error ? err.message : err}`));
      else console.log('See the pool live with "omnitrix dashboard".');
    };
    if (!found.length) {
      console.log('Nothing to connect was found. Run "omnitrix providers" to see what omnitrix supports.');
      await dashboard();
      return;
    }
    console.log('Found on this computer:');
    for (const f of found) {
      const mark = f.action === 'add' ? '+' : f.action === 'connected' ? '=' : '-';
      const state = f.action === 'add' ? (o.apply ? 'connecting' : 'not connected yet')
        : f.action === 'connected' ? `already connected as ${f.connectedAs!.join(', ')}` : `not added: ${f.reason}`;
      console.log(`  ${mark} ${f.name.padEnd(26)} ${f.how.padEnd(44)} ${state}`);
    }
    const todo = found.filter((f) => f.action === 'add');
    if (!o.apply) {
      console.log(todo.length ? `\nNothing was changed. Run "omnitrix init --apply" to connect the ${todo.length} marked with +.` : '\nEverything found is already connected.');
    } else {
      for (const f of todo) {
        console.log(`\n${f.name}:`);
        await addAccount(f.provider, { owner: 'me' });
      }
    }
    console.log('\nTo use omnitrix from Claude Code, run "omnitrix setup-claude" once, then restart Claude Code.');
    await dashboard();
  });

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

/** Who this developer is in the team: an explicit name, else their git email, else their login name. */
function defaultUser(): string {
  const git = spawnSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', windowsHide: true });
  return git.status === 0 && git.stdout.trim() ? git.stdout.trim() : os.userInfo().username;
}

const team = program.command('team').description('share company API accounts, prices and budgets through a team file');

team
  .command('join <file>')
  .description('review a team file, then join it with --yes')
  .option('--as <name>', 'who you are in the team (default: your git email)')
  .option('--yes <code>', 'join, giving the review code shown when you reviewed the file')
  .action((file: string, o) => {
    const full = path.resolve(file);
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      die(`cannot read ${full}`);
    }
    let parsed: TeamFile;
    try {
      parsed = parseTeam(text);
    } catch (err) {
      die(err instanceof Error ? err.message : String(err));
    }
    const user = o.as ?? defaultUser();
    const code = reviewCode(text);
    if (o.yes !== undefined && o.yes !== code) {
      // the code ties the join to the exact contents that were reviewed, so a file edited in between is not pinned
      die(`the review code ${o.yes} does not match this file: it has changed since you reviewed it, or the code is wrong. Run "omnitrix team join ${file}" without --yes to review it again`);
    }
    // everything a key could be sent to, so the developer can see where their keys would go
    console.log(`${parsed.name} (${full})`);
    console.log('Accounts, and where their keys would be sent:');
    const warnings: string[] = [];
    for (const a of teamAccounts(parsed)) {
      const spec = parsed.accounts.find((s) => s.id === a.id)!;
      const host = new URL(a.baseUrl!).host;
      const official = officialHost(a.provider);
      const where = official === undefined ? `${host} (a custom address)` : host === official ? host : `${host} (not the provider's own address, ${official})`;
      const set = process.env[spec.keyEnv] ? 'set' : 'not set on this computer';
      const limit = [spec.usdPerDay !== undefined ? `${money(spec.usdPerDay)} a day` : '', spec.usdPerMonth !== undefined ? `${money(spec.usdPerMonth)} a month` : ''].filter(Boolean).join(', ');
      console.log(`  ${a.id.padEnd(18)} ${a.provider.padEnd(14)} ${where.padEnd(30)} key from ${spec.keyEnv} (${set})${limit ? `; team limit ${limit}` : ''}${a.trainsOnData ? '; may train on prompts, so public tasks only' : ''}`);
      if (PROVIDERS.some((p) => p.keyEnv === spec.keyEnv)) warnings.push(`${spec.keyEnv} usually holds a personal key; ask the team to use a variable of its own, such as ACME_${spec.keyEnv}`);
    }
    for (const m of unpricedModels(parsed)) warnings.push(`no price for ${m}, so its requests count as costing nothing against budgets`);
    const b = budgetFor(parsed, user);
    console.log(`Your budget as ${user}: ${b.day !== undefined ? `${money(b.day)} a day` : 'no daily limit'}, ${b.month !== undefined ? `${money(b.month)} a month` : 'no monthly limit'}`);
    if (o.as && o.as !== defaultUser()) console.log(`  (your git email is ${defaultUser()})`);
    if (parsed.auditDir) console.log(`Your name and your requests on team accounts (account, model, tokens, cost; never prompts or results) are also copied to ${parsed.auditDir}`);
    for (const w of warnings) console.log(`warning: ${w}`);
    if (o.yes === undefined) {
      console.log(`\nreview code: ${code}`);
      console.log(`Nothing was changed. If this looks right, join with: omnitrix team join ${file}${o.as ? ` --as ${o.as}` : ''} --yes ${code}`);
      return;
    }
    const clash = updateConfig((cfg) => {
      cfg.settings.team = { file: full, user, sha256: fingerprint(text) };
      return parsed.accounts.filter((a) => cfg.accounts.some((own) => own.id === a.id && !own.team)).map((a) => a.id);
    });
    console.log(`\njoined ${parsed.name} as ${user}`);
    if (clash.length) console.log(`note: you already have accounts named ${clash.join(', ')}; your own ones are used, and the team's are not loaded`);
    console.log('If the team file changes later, its accounts stop loading until you review it here again.');
  });

team
  .command('leave')
  .description('stop using the team file')
  .action(() => {
    const cfg = loadConfig();
    const state = cfg.settings.team ? loadTeam(cfg.settings.team) : undefined;
    if (!state) {
      console.log('You are not in a team.');
      return;
    }
    updateConfig((latest) => {
      latest.settings.team = undefined;
    });
    console.log(`left ${state.team?.name ?? 'the team'}`);
  });

team
  .command('status', { isDefault: true })
  .description('show the team, who you are and what you have spent')
  .action(() => {
    const cfg = loadConfig();
    if (!cfg.settings.team) {
      console.log('You are not in a team. Join one with: omnitrix team join <file>');
      return;
    }
    const state = loadTeam(cfg.settings.team);
    if (!state.team) {
      console.log(`Team accounts are not loaded: ${state.error}`);
      return;
    }
    const { user } = state.membership;
    const s = personSpend(state.team, user, readLedger(periodStart(Date.now(), 'month')));
    const b = budgetFor(state.team, user);
    console.log(`${state.team.name}, as ${user} (${state.membership.file})`);
    console.log(`  today: ${money(s.day)}${b.day !== undefined ? ` of ${money(b.day)}` : ''}`);
    console.log(`  this month: ${money(s.month)}${b.month !== undefined ? ` of ${money(b.month)}` : ''}`);
    console.log(`  accounts: ${state.accounts.map((a) => a.id).join(', ')}`);
  });

program
  .command('usage')
  .description('requests, tokens and cost, grouped by person, account or model')
  .addOption(new Option('--by <what>', 'how to group').choices(['person', 'account', 'model']).default('account'))
  .option('--days <n>', 'how far back', int, 30)
  .option('--team', "everyone's usage from the team's shared folder instead of this computer's")
  .action((o) => {
    const since = Date.now() - o.days * 24 * 3600_000;
    let records: UsageRecord[];
    if (o.team) {
      const cfg = loadConfig();
      const state = cfg.settings.team ? loadTeam(cfg.settings.team) : undefined;
      if (!state?.team?.auditDir) die('the team file names no shared folder (auditDir), so there is no team-wide log to read');
      records = readShared(state.team.auditDir, since);
    } else {
      records = readLedger(since);
    }
    const groups = new Map<string, { n: number; failed: number; tokens: number; cost: number }>();
    for (const r of records) {
      const key = o.by === 'person' ? r.user ?? '(you, outside a team)' : o.by === 'model' ? `${r.accountId}/${r.model}` : r.accountId;
      const g = groups.get(key) ?? { n: 0, failed: 0, tokens: 0, cost: 0 };
      g.n++;
      if (!r.ok) g.failed++;
      g.tokens += r.inputTokens + r.outputTokens;
      g.cost += r.costUsd ?? 0;
      groups.set(key, g);
    }
    if (!groups.size) {
      console.log(`no requests in the last ${o.days} days`);
      return;
    }
    const rows = [...groups.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].n - a[1].n);
    const width = Math.max(...rows.map(([k]) => k.length)) + 2;
    for (const [key, g] of rows) {
      // shared records come from colleagues' machines; never print control characters from them
      const k = key.replace(/[\p{Cc}\p{Cf}]/gu, '?');
      console.log(`${k.padEnd(width)}${`${g.n} requests`.padEnd(14)}${`${formatTokens(g.tokens)} tokens`.padEnd(16)}${money(g.cost).padEnd(10)}${g.failed ? `${g.failed} failed` : ''}`);
    }
    // the work other accounts did instead of Claude; the team's shared log has no job verdicts
    if (!o.team) {
      const d = new Engine().delegated(o.days);
      if (d.jobs) console.log(`\n${describeDelegated(d)}.`);
    }
    console.log('\nCosts are those reported by the provider, or estimated from model prices where they are known.');
  });

program
  .command('rebase <job>')
  .description("move a finished code job's branch onto the repository's current HEAD and check it again")
  .option('--json', 'machine-readable output')
  .action(async (id: string, o: { json?: boolean }) => {
    if (!JOB_ID.test(id)) die(`"${id}" is not a job id`);
    const out = await new Engine().rebase(id);
    if (o.json) console.log(JSON.stringify(out, null, 2));
    else if (out.status === 'rebased') console.log(`rebased onto ${out.onto.slice(0, 10)}; ${verifySummary(out.verify)}`);
    else if (out.status === 'up_to_date') console.log('already starts from the current HEAD; nothing to do');
    else if (out.status === 'conflict') console.log(`conflict in ${out.files.join(', ')}; nothing was changed. Merge this job by hand, or retry it from the current HEAD.`);
    else console.log(`cannot rebase: ${out.reason}`);
    if (out.status === 'conflict' || out.status === 'not_possible') process.exitCode = 1;
    process.exit();
  });

program
  .command('report')
  .description('what the workers did: jobs, acceptance by Claude, time and tokens per model and task type')
  .option('--days <n>', 'how far back', int, 30)
  .option('--json', 'machine-readable output')
  .action((o: { days: number; json?: boolean }) => {
    const since = Date.now() - o.days * 24 * 3600_000;
    const r = buildReport(jobsSince(since), since);
    console.log(o.json ? JSON.stringify(r, null, 2) : formatReport(r, o.days));
  });

program
  .command('overhead')
  .description("how much of Claude's own work went into running omnitrix, read from Claude Code's session files on this computer")
  .option('--days <n>', 'how far back', int, 30)
  .option('--json', 'machine-readable output')
  .action(async (o: { days: number; json?: boolean }) => {
    const since = Date.now() - o.days * 24 * 3600_000;
    const claude = await measureOverhead(claudeProjectsDir(), since);
    const { tokens, acceptedTokens } = buildReport(jobsSince(since), since).totals;
    const workers = { tokens, acceptedTokens };
    if (o.json) console.log(JSON.stringify({ days: o.days, claude: { ...claude, resultTokens: resultTokens(claude) }, workers }, null, 2));
    else console.log(formatOverhead(claude, workers, o.days));
  });

program
  .command('mcp-config')
  .description('print the MCP server entry for other apps, such as Cursor or VS Code, with the paths on this computer')
  .action(() => {
    // the full paths of node and of this file, so the app needs neither PATH nor the npm shim
    const entry = { type: 'stdio', command: process.execPath, args: [fileURLToPath(import.meta.url), 'mcp'] };
    console.log(JSON.stringify({ mcpServers: { omnitrix: entry } }, null, 2));
  });

program
  .command('setup-claude')
  .description('register omnitrix in Claude Code and add the status line')
  .addOption(new Option('--scope <scope>', 'where to register the MCP server').choices(['user', 'project', 'local']).default('user'))
  .option('--no-statusline', 'do not touch the status line')
  .option('--dry-run', 'only print what would be done')
  .action((o) => {
    const script = fileURLToPath(import.meta.url);
    const node = process.execPath;
    const mcpArgs = ['mcp', 'add', '--scope', o.scope, 'omnitrix', '--', node, script, 'mcp'];
    console.log(`1. claude ${mcpArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    if (!o.dryRun) {
      const claude = resolveCommand('claude');
      if (!claude) {
        console.log('   Claude Code CLI not found on PATH; run the line above yourself after installing it.');
      } else {
        const r = spawnSync(claude.file, [...claude.prefix, ...mcpArgs], { stdio: 'inherit', shell: claude.shell });
        if (r.status !== 0) console.log('   that did not work; if omnitrix is already registered, remove it with "claude mcp remove omnitrix" and retry.');
      }
    }
    if (o.statusline) {
      const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
      const command = `"${node}" "${script}" statusline`;
      console.log(`2. statusLine in ${settingsFile}: ${command}`);
      if (!o.dryRun) {
        let settings: Record<string, any> = {};
        if (fs.existsSync(settingsFile)) {
          try {
            settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
          } catch {
            die(`${settingsFile} is not valid JSON; fix it first`);
          }
          // keep a copy so the user can always get their old settings back
          fs.copyFileSync(settingsFile, `${settingsFile}.bak-omnitrix`);
        }
        // never replace a status line someone set up themselves
        if (settings.statusLine && !String(settings.statusLine.command ?? '').includes('omnitrix') && !String(settings.statusLine.command ?? '').includes('statusline')) {
          console.log(`   you already have a status line (${settings.statusLine.command}); left it alone. Use --no-statusline to skip this step.`);
        } else {
          // Claude Code stops redrawing while it waits on tools, so refresh on a timer as well
          settings.statusLine = { type: 'command', command, refreshInterval: 15 };
          fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
          fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
          console.log('   done (backup saved next to it).');
        }
      }
    }
    console.log('Restart Claude Code, then ask it to "use omnitrix" for big jobs.');
  });

program
  .command('lockcheck [files...]')
  .description('after regenerating a lockfile, show which packages were added, changed or removed compared with a git revision')
  .option('--base <rev>', 'the revision to compare with', 'HEAD')
  .option('--repo <dir>', 'the repository folder', '.')
  .option('--json', 'print the full result as JSON')
  .action((names: string[], o) => {
    let results;
    try {
      results = checkLockfiles(path.resolve(o.repo), o.base, names);
    } catch (e) {
      fail((e as Error).message);
      return;
    }
    if (o.json) console.log(JSON.stringify(results, null, 2));
    else if (!results.length) console.log(`no lockfile differs from ${o.base}`);
    else for (const r of results) console.log(describeLock(r));
    // exit code 1 when anything needs a person's review: a changed or removed package, or a file that could not be checked
    if (results.some((r) => r.additiveOnly !== true)) process.exitCode = 1;
  });

program
  .command('clean')
  .description('delete old job records, outputs and worktrees; --branches also deletes branches no longer needed')
  .option('--days <n>', 'only things older than this many days', int, 14)
  .option('--branches', 'also delete the branches of rejected, failed or cancelled jobs, and of other jobs once merged')
  .option('--dry-run', 'only report what would be deleted')
  .action((o) => {
    const cutoff = Date.now() - o.days * 24 * 3600_000;
    let jobs = 0;
    let trees = 0;
    let branches = 0;
    const kept: string[] = [];
    let stuck = 0;
    for (const name of fs.existsSync(files.jobs()) ? fs.readdirSync(files.jobs()) : []) {
      const file = path.join(files.jobs(), name);
      // cancel notes are empty files; one left from a cancel that raced a finishing job is just litter
      if (name.endsWith('.cancel')) {
        if (!o.dryRun && fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
        continue;
      }
      const job = readJson<Job | null>(file, null);
      // a record that is not omnitrix's own for this file name could point anywhere, so it is left alone
      if (!job || `${job.id}.json` !== name || !JOB_ID.test(job.id)) continue;
      if (job.updatedAt > cutoff || job.status === 'queued' || job.status === 'running') continue;
      // a finished job whose test or check is still running is in use: its process saves the record again later
      const unsettled = job.verify?.test?.status === 'running' || job.check?.status === 'pending';
      if (unsettled && ownerAlive(job.owner, job.pid)) continue;
      jobs++;
      // only a worktree inside omnitrix's own folder is ever deleted
      const tree = job.worktree && path.resolve(job.worktree.path) !== path.resolve(files.worktrees()) && inside(job.worktree.path, files.worktrees()) ? job.worktree.path : undefined;
      if (o.dryRun) {
        if (tree) trees++;
      } else {
        if (tree && pruneWorktree(tree)) trees++;
      }
      const repo = job.task.repo;
      // only the branch omnitrix made for this job, in a repository given by absolute path, is ever touched
      const branch = job.worktree?.branch === `omnitrix/${job.id}` ? job.worktree.branch : undefined;
      let keepRecord = false;
      if (o.branches && repo && branch && path.isAbsolute(repo) && fs.existsSync(repo) && branchExists(repo, branch)) {
        // rejected or broken work is not wanted; anything else goes only once it is in the repo's history
        const unwanted = job.verdict === 'rejected' || job.status === 'failed' || job.status === 'cancelled';
        if (!unwanted && !branchMerged(repo, branch)) {
          kept.push(branch);
          keepRecord = true;
        } else if (o.dryRun || deleteBranch(repo, branch)) {
          branches++;
        } else {
          // for example, the branch is checked out somewhere
          stuck++;
          keepRecord = true;
        }
      }
      // a kept branch keeps its record, so a later clean can still decide about it once it is merged or rejected
      if (o.dryRun || keepRecord) continue;
      fs.rmSync(path.join(files.outputs(), `${job.id}.md`), { force: true });
      fs.rmSync(file, { force: true });
    }
    // read-only copies are not on any job record; one left by a process that died is removed once it is old
    for (const name of fs.existsSync(files.worktrees()) ? fs.readdirSync(files.worktrees()) : []) {
      const dir = path.join(files.worktrees(), name);
      if (!/^j[0-9a-z]{4,40}-ro(-[0-9a-z]+)?$/.test(name) || fs.statSync(dir).mtimeMs >= cutoff) continue;
      trees++;
      if (!o.dryRun) pruneWorktree(dir);
    }
    // temp files of a save that a crash interrupted; a young one may belong to a save happening right now
    let temps = 0;
    const tempCutoff = Math.min(cutoff, Date.now() - 10 * 60_000);
    for (const dir of [homeDir(), files.jobs()]) {
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!/\.\d+\.\d+\.tmp$/.test(name)) continue;
        const file = path.join(dir, name);
        try {
          if (!fs.statSync(file).isFile() || fs.statSync(file).mtimeMs >= tempCutoff) continue;
          if (!o.dryRun) fs.rmSync(file);
          temps++;
        } catch {
          // gone already, or held open by another program
        }
      }
    }
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    console.log(`${o.dryRun ? 'would remove' : 'removed'} ${count(jobs, 'old job', 'old jobs')} and ${count(trees, 'worktree', 'worktrees')}${temps ? `, and ${count(temps, 'leftover temp file', 'leftover temp files')}` : ''}`);
    if (o.branches) {
      // Work copied with "git checkout <branch> -- <file>" never counts as merged, so a kept branch is named:
      // only the user knows whether it is still needed.
      const names = kept.sort();
      const shown = names.length ? `: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', ...' : ''}` : '';
      console.log(`${o.dryRun ? 'would delete' : 'deleted'} ${count(branches, 'branch', 'branches')}, ${o.dryRun ? 'would keep' : 'kept'} ${kept.length} that are not merged${shown}${stuck ? `, could not delete ${stuck}` : ''}`);
      if (names.length) console.log('Once a kept branch is no longer needed, delete it with "git branch -D <name>" in its repository.');
    }
  });

program
  .command('doctor')
  .description('check the setup and every account')
  .action(() => {
    const ok = (b: boolean, msg: string) => console.log(`${b ? ' ok ' : 'FAIL'}  ${msg}`);
    const major = Number(process.versions.node.split('.')[0]);
    ok(major >= 20, `node ${process.versions.node} (needs 20+)`);
    ensureHome();
    ok(fs.existsSync(homeDir()), `data folder ${homeDir()}`);
    const cfg = loadConfig();
    ok(cfg.accounts.length > 0, `${cfg.accounts.length} accounts`);
    const health = loadHealth();
    const ledger = readLedger(Date.now() - 32 * 24 * 3600_000);
    const answered = new Set(ledger.filter((r) => r.ok).map((r) => r.accountId));
    for (const a of cfg.accounts) {
      if (a.driver === 'cli') {
        const tool = CLI_TOOLS[providerTool(a.provider)];
        ok(!!tool && !!resolveCommand(tool.command), `${a.id}: ${tool?.command ?? a.provider} installed`);
      } else {
        const keyOk = a.local || (a.apiKey?.startsWith('env:') ? !!process.env[a.apiKey.slice(4)] : a.apiKey === 'secret');
        ok(keyOk, `${a.id}: API key ${a.apiKey?.startsWith('env:') ? `from ${a.apiKey.slice(4)}` : a.local ? 'not needed' : 'saved'}`);
      }
      ok(a.models.length > 0, `${a.id}: ${a.models.length} models`);
      // A key and a model list do not prove that requests work, so the last real request counts too.
      // doctor itself sends nothing, so it never spends anyone's quota.
      const h = health[a.id];
      const broken = h && (h.state === 'auth_error' || h.state === 'disabled' || ((h.state === 'offline' || h.state === 'exhausted') && (h.until ?? Infinity) > Date.now()));
      if (broken) ok(false, `${a.id}: last request failed: ${(h.reason ?? h.state).slice(0, 160)}`);
      const drift = driftHint(a.id, ledger.filter((r) => r.accountId === a.id));
      if (drift) console.log(`note  ${drift}`);
      else if (!answered.has(a.id)) console.log(`note  ${a.id}: no request has been sent yet; "omnitrix test ${a.id}" sends one`);
    }
    if (cfg.accounts.some((a) => a.apiKey?.startsWith('env:'))) {
      console.log('note  Claude Code passes on only the key variables that existed when it started; restart it after setting one');
    }
  });

program.parseAsync().catch((err) => fail(err instanceof Error ? err.message : String(err)));
