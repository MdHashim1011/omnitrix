#!/usr/bin/env node
// The omnitrix command line: add and manage accounts, check usage, and wire omnitrix into Claude Code.
// It reads and writes the same files in ~/.omnitrix that the MCP server uses.
import { Command, Option } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDashboard } from './dashboard.js';
import { discoverModels, runDriver } from './drivers/index.js';
import { CLI_TOOLS, loginCli, providerTool, resolveCommand } from './drivers/cli.js';
import { Engine } from './engine.js';
import { describeAccount } from './mcp.js';
import { isChatModel, makeModel } from './models.js';
import { PROVIDERS, getProvider } from './providers.js';
import { renderStatusLine } from './statusline.js';
import { deleteSecret, ensureHome, files, findAccount, homeDir, loadConfig, readJson, redact, saveConfig, saveHealth, setSecret, uniqueAccountId } from './store.js';
import { pruneWorktree } from './worktree.js';
import { DriverError, TASK_TYPES, type Account, type Job, type Limits, type TaskType } from './types.js';
import { recordUsage } from './usage.js';
import { VERSION } from './version.js';

const program = new Command();
program.name('omnitrix').description('One Claude brain, every AI account you have.').version(VERSION);

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
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
  .action(() => {
    const groups: [string, (p: (typeof PROVIDERS)[number]) => boolean][] = [
      ['Agent CLIs (sign in with a subscription, can edit files)', (p) => p.driver === 'cli'],
      ['Hosted APIs', (p) => p.driver !== 'cli' && !p.local && !p.id.startsWith('custom')],
      ['On your own machine', (p) => !!p.local],
      ['Anything else', (p) => p.id.startsWith('custom')],
    ];
    for (const [title, test] of groups) {
      console.log(`\n${title}`);
      for (const p of PROVIDERS.filter(test)) {
        const pad = `\n  ${''.padEnd(17)} `;
        console.log(`  ${p.id.padEnd(17)} ${p.name}${p.signup ? `${pad}${p.signup}` : ''}${p.note ? `${pad}${p.note}` : ''}`);
      }
    }
    console.log('\nAdd one with: omnitrix add <provider> --key-env NAME   (or --key, --base-url, --model)');
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
).action(async (providerId: string, o: Record<string, any>) => {
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
  if (driver !== 'cli' && !baseUrl) die('this provider needs --base-url');
  if (driver === 'cli' && o.baseUrl) baseUrl = o.baseUrl;
  else if (driver === 'cli') baseUrl = undefined;

  let apiKey: string | undefined;
  if (o.keyEnv) apiKey = `env:${o.keyEnv}`;
  else if (o.key) apiKey = 'secret';
  // a key already sitting in the usual environment variable is used without asking
  else if (spec.keyEnv && process.env[spec.keyEnv] && driver !== 'cli') apiKey = `env:${spec.keyEnv}`;
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
      account.models = found.slice(0, 200).map((m) => makeModel(m));
      console.log(`found ${found.length} models`);
    } catch (err) {
      console.log(`could not list models (${err instanceof Error ? redact(err.message) : err})`);
    }
    if (!account.models.length && spec.models?.length) account.models = spec.models.map((m) => makeModel(m));
    if (!account.models.length) {
      if (o.key) deleteSecret(id);
      die('no models found; pass them with --model id1,id2');
    }
  }

  cfg.accounts.push(account);
  saveConfig(cfg);
  console.log(`added ${id} (${spec.name}, ${account.models.length} model${account.models.length === 1 ? '' : 's'}, owner ${account.owner})`);
  if (spec.note) console.log(`note: ${spec.note}`);
  if (account.owner !== 'me' && (spec.id === 'claude-code' || spec.id === 'antigravity')) {
    console.log('warning: Anthropic and Google do not allow letting other people use an account. Use accounts you own.');
  }
  if (driver === 'cli') {
    if (o.login) {
      const code = loginCli(account);
      if (code !== 0) console.log(`login exited with code ${code}; try again with: omnitrix login ${id}`);
    } else if (spec.id === 'codex' || spec.id === 'claude-code' || spec.id === 'opencode') {
      console.log(`next: omnitrix login ${id}`);
    }
  }
  console.log(`check it with: omnitrix test ${id}`);
});

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
  .action((o) => {
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
  const cfg = loadConfig();
  const acc = findAccount(cfg, id) ?? die(`no account "${id}"`);
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
  saveConfig(cfg);
  if (o.key || o.keyEnv) saveHealth({ [id]: { state: 'ready' } });
  console.log(`updated ${id}`);
});

for (const [name, value] of [['enable', true], ['disable', false]] as const) {
  program
    .command(`${name} <id>`)
    .description(`${name} an account`)
    .action((id: string) => {
      const cfg = loadConfig();
      const acc = findAccount(cfg, id) ?? die(`no account "${id}"`);
      acc.enabled = value;
      saveConfig(cfg);
      if (value) saveHealth({ [id]: { state: 'ready' } });
      console.log(`${id} ${value ? 'enabled' : 'disabled'}`);
    });
}

program
  .command('remove <id>')
  .description('remove an account (its CLI profile folder is kept unless --purge)')
  .option('--purge', 'also delete the profile folder with the saved login')
  .action((id: string, o) => {
    const cfg = loadConfig();
    const acc = findAccount(cfg, id) ?? die(`no account "${id}"`);
    cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
    saveConfig(cfg);
    deleteSecret(id);
    if (o.purge && acc.profileDir) fs.rmSync(acc.profileDir, { recursive: true, force: true });
    console.log(`removed ${id}${acc.profileDir && !o.purge ? ` (profile kept at ${acc.profileDir})` : ''}`);
  });

program
  .command('models <id>')
  .description('show an account\'s models and their skill scores')
  .option('--refresh', 'ask the provider for its current model list')
  .action(async (id: string, o) => {
    const cfg = loadConfig();
    const acc = findAccount(cfg, id) ?? die(`no account "${id}"`);
    if (o.refresh) {
      const found = (await discoverModels(acc)).filter(isChatModel);
      if (!found.length) die('the provider returned no models');
      const old = new Map(acc.models.map((m) => [m.id, m]));
      acc.models = found.map((m) => old.get(m) ?? makeModel(m));
      saveConfig(cfg);
      console.log(`now ${acc.models.length} models`);
    }
    console.log('model'.padEnd(44) + 'code reas writ long vis  speed');
    for (const m of acc.models) {
      const s = m.skills;
      console.log(`${(m.id + (m.pinned ? ' *' : '')).padEnd(44)}${[s.coding, s.reasoning, s.writing, s.longContext, s.vision, s.speed].map((n) => String(n).padEnd(5)).join('')}`);
    }
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
    const cfg = loadConfig();
    const acc = findAccount(cfg, id) ?? die(`no account "${id}"`);
    if (o.remove) {
      acc.models = acc.models.filter((m) => m.id !== modelId);
      saveConfig(cfg);
      return console.log(`removed ${modelId} from ${id}`);
    }
    let m = acc.models.find((x) => x.id === modelId);
    if (!m) {
      if (!o.add) die(`${id} has no model "${modelId}" (use --add)`);
      m = makeModel(modelId);
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
    if (touched) m.pinned = true;
    if (o.inputPrice !== undefined) m.inputPrice = o.inputPrice;
    if (o.outputPrice !== undefined) m.outputPrice = o.outputPrice;
    saveConfig(cfg);
    console.log(`${id}/${modelId}: ${JSON.stringify(m.skills)}`);
  });

program
  .command('test <id>')
  .description('send a tiny request to check that an account works')
  .option('--model <id>')
  .action(async (id: string, o) => {
    const acc = findAccount(loadConfig(), id) ?? die(`no account "${id}"`);
    const model = o.model ?? acc.models[0]?.id ?? 'default';
    const t0 = Date.now();
    process.stdout.write(`testing ${id}/${model} ... `);
    try {
      const r = await runDriver({ account: acc, model, prompt: 'Reply with the single word OK.', timeoutMs: 180_000, maxOutputTokens: 64 });
      const ms = Date.now() - t0;
      recordUsage({ ts: Date.now(), accountId: id, model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ok: true, latencyMs: ms, costUsd: r.costUsd });
      saveHealth({ [id]: { state: 'ready', measured: r.rate ? { ...r.rate, at: Date.now(), source: 'response headers' } : undefined } });
      console.log(`ok in ${(ms / 1000).toFixed(1)}s: "${r.text.trim().slice(0, 60)}"`);
      if (r.rate?.remainingRequests !== undefined) console.log(`provider says ${r.rate.remainingRequests} requests left in this window`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('failed');
      if (err instanceof DriverError && err.kind === 'auth') saveHealth({ [id]: { state: 'auth_error', reason: msg.slice(0, 160) } });
      die(redact(msg));
    }
  });

program
  .command('run <prompt...>')
  .description('send one task through the router and print the answer')
  .addOption(new Option('--type <type>', 'task type').choices([...TASK_TYPES]).default('writing'))
  .addOption(new Option('--privacy <level>').choices(['public', 'private', 'secret']))
  .option('--use <account[/model]>', 'force an account or model')
  .option('--repo <path>', 'git repo for code tasks')
  .action(async (words: string[], o) => {
    const engine = new Engine();
    const prompt = words.join(' ');
    const [job] = engine.dispatch([{ title: prompt.slice(0, 60), type: o.type as TaskType, prompt, privacy: o.privacy, use: o.use, repo: o.repo ? path.resolve(o.repo) : undefined }]);
    // wait a moment first so the chosen account is printed before the answer arrives
    let done = await engine.wait([job!.id], 1);
    if (done[0]?.accountId) process.stderr.write(`-> ${done[0].accountId}/${done[0].model}\n`);
    while (done[0] && (done[0].status === 'queued' || done[0].status === 'running')) done = await engine.wait([job!.id], 30);
    const j = done[0]!;
    if (j.status !== 'done') die(j.error ?? j.status);
    process.stderr.write(`(${j.accountId}/${j.model}, ${(j.usage?.inputTokens ?? 0) + (j.usage?.outputTokens ?? 0)} tokens)\n`);
    console.log(engine.readOutput(j.id) ?? j.preview);
    process.exit(0);
  });

program
  .command('route <prompt...>')
  .description('show which account and model would get a task, without running it')
  .addOption(new Option('--type <type>', 'task type').choices([...TASK_TYPES]).default('writing'))
  .addOption(new Option('--privacy <level>').choices(['public', 'private', 'secret']))
  .action((words: string[], o) => {
    const { candidates, rejected } = new Engine().preview({ title: 'preview', type: o.type, prompt: words.join(' '), privacy: o.privacy });
    if (!candidates.length) console.log('nobody can take this task');
    candidates.slice(0, 8).forEach((c, i) => console.log(`${String(i + 1).padStart(2)}. ${`${c.accountId}/${c.model}`.padEnd(46)} ${c.score.toFixed(3)}  ${c.why.join(', ')}`));
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
    const cfg = loadConfig();
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
    saveConfig(cfg);
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
  .description('open a live web dashboard of all accounts')
  .option('--port <n>', 'port', int, 4590)
  .option('--no-open', 'do not open the browser')
  .action((o) => {
    const url = startDashboard(o.port);
    console.log(`dashboard: ${url}  (Ctrl+C to stop)`);
    if (o.open) {
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawnSync(opener[0] as string, opener[1] as string[], { stdio: 'ignore' });
    }
  });

program
  .command('mcp')
  .description('run the MCP server (Claude Code starts this for you)')
  .action(async () => {
    const { startMcp } = await import('./mcp.js');
    startMcp();
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
  .command('clean')
  .description('delete old job records, outputs and worktrees (branches are kept)')
  .option('--days <n>', 'only things older than this many days', int, 14)
  .action((o) => {
    const cutoff = Date.now() - o.days * 24 * 3600_000;
    let jobs = 0;
    let trees = 0;
    for (const name of fs.existsSync(files.jobs()) ? fs.readdirSync(files.jobs()) : []) {
      const file = path.join(files.jobs(), name);
      const job = readJson<Job | null>(file, null);
      if (!job || job.updatedAt > cutoff || job.status === 'queued' || job.status === 'running') continue;
      if (job.worktree && pruneWorktree(job.worktree.path)) trees++;
      if (job.outputFile) fs.rmSync(job.outputFile, { force: true });
      fs.rmSync(file, { force: true });
      jobs++;
    }
    console.log(`removed ${jobs} old jobs and ${trees} worktrees`);
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
    for (const a of cfg.accounts) {
      if (a.driver === 'cli') {
        const tool = CLI_TOOLS[providerTool(a.provider)];
        ok(!!tool && !!resolveCommand(tool.command), `${a.id}: ${tool?.command ?? a.provider} installed`);
      } else {
        const keyOk = a.local || (a.apiKey?.startsWith('env:') ? !!process.env[a.apiKey.slice(4)] : a.apiKey === 'secret');
        ok(keyOk, `${a.id}: API key ${a.apiKey?.startsWith('env:') ? `from ${a.apiKey.slice(4)}` : a.local ? 'not needed' : 'saved'}`);
      }
      ok(a.models.length > 0, `${a.id}: ${a.models.length} models`);
    }
  });

program.parseAsync().catch((err) => die(err instanceof Error ? err.message : String(err)));
