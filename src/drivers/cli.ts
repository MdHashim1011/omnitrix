import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider } from '../providers.js';
import { files, redact, resolveKey } from '../store.js';
import { DriverError, type Account, type DriverRequest, type DriverResult, type Effort, type ErrorKind } from '../types.js';

/**
 * Agent CLIs (Codex, Claude Code, Gemini, Qwen, Antigravity, OpenCode).
 * Each account gets its own config folder, so several accounts of the same tool never mix.
 * The prompt always goes in through stdin, never on the command line.
 */
export interface CliTool {
  id: string;
  command: string;
  /** env var that points the tool at a config folder; "HOME" means override the home folder */
  profileEnv: string;
  /** args for a run; edit=true when the task may change files */
  args(opts: { model?: string; edit: boolean; cwd: string; outFile: string; effort?: Effort; off?: string[] }): string[];
  parse(stdout: string, outFile: string): { text: string; inputTokens: number; outputTokens: number; costUsd?: number; error?: string };
  loginArgs: string[];
  /** extra env for a run */
  env?(account: Account): Record<string, string | undefined>;
  /** prepare a fresh profile folder */
  initProfile?(dir: string): void;
  /** the tool reports at once that it started (Codex with --json), so a long silence at the start means it hangs */
  reportsStart?: boolean;
}

const SAFE_ARG = /^[\w.:@\/=,+\-]+$/;

function lines(stdout: string): any[] {
  const out: any[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* not JSON */
    }
  }
  return out;
}

function lastJson(stdout: string): any {
  const all = lines(stdout);
  if (all.length) return all[all.length - 1];
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      return JSON.parse(stdout.slice(start));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

/**
 * The models that the Codex login of this account may use, newest first, as Codex lists them in its model
 * picker. Codex saves the list in models_cache.json in its home folder after it has run once; models it
 * hides from the picker are left out. Without that file the list is empty.
 */
export function codexModels(account: Account): string[] {
  if (!account.profileDir) return [];
  let cache: unknown;
  try {
    cache = JSON.parse(fs.readFileSync(path.join(account.profileDir, 'models_cache.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = (cache as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is { slug: string; visibility?: unknown; priority?: unknown } => !!m && typeof m.slug === 'string' && /^[\w.:-]{1,80}$/.test(m.slug) && m.visibility === 'list')
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((m) => m.slug);
}

export const CLI_TOOLS: Record<string, CliTool> = {
  codex: {
    id: 'codex',
    reportsStart: true,
    command: 'codex',
    profileEnv: 'CODEX_HOME',
    args: ({ model, edit, cwd, outFile, effort, off }) => [
      'exec', '--json', '--skip-git-repo-check', '--ephemeral',
      ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
      // as config settings rather than --disable, which refuses the whole run over a name it does not know
      ...(off ?? []).flatMap((f) => ['-c', `features.${f}=false`]),
      // plain workspace-write still refuses file writes on Windows; --approve-for-me keeps that
      // sandbox but lets Codex's own reviewer approve the edits instead of a human
      ...(edit ? ['--approve-for-me'] : ['--sandbox', 'read-only']),
      '-C', cwd, '-o', outFile,
      ...(model && model !== 'default' ? ['-m', model] : []),
      '-',
    ],
    parse(stdout, outFile) {
      const events = lines(stdout);
      let inputTokens = 0;
      let outputTokens = 0;
      let error: string | undefined;
      let lastMessage = '';
      for (const e of events) {
        if (e.type === 'turn.completed' && e.usage) {
          inputTokens += Number(e.usage.input_tokens ?? 0);
          // reasoning_output_tokens is the part of output_tokens spent thinking, not an addition to it
          outputTokens += Number(e.usage.output_tokens ?? 0);
        }
        if (e.type === 'turn.failed') error = e.error?.message ?? 'turn failed';
        if (e.type === 'error') error = e.message ?? 'error';
        if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') lastMessage = e.item.text;
      }
      let text = lastMessage;
      try {
        text = fs.readFileSync(outFile, 'utf8') || lastMessage;
      } catch {
        /* -o file missing: use the streamed message */
      }
      return { text, inputTokens, outputTokens, error: text ? undefined : error };
    },
    loginArgs: ['login'],
    initProfile(dir) {
      // keep the login inside this folder instead of the shared OS keychain
      const file = path.join(dir, 'config.toml');
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'cli_auth_credentials_store = "file"\n');
    },
  },

  claude: {
    id: 'claude',
    command: 'claude',
    profileEnv: 'CLAUDE_CONFIG_DIR',
    args: ({ model, edit }) => [
      // documented as `cat file | claude -p '...'`: the short prompt here, the task on standard input
      '-p', 'Follow the instructions given on standard input.',
      '--output-format', 'json', '--permission-prompts', 'none',
      '--permission-mode', edit ? 'acceptEdits' : 'dontAsk',
      '--allowedTools', edit ? 'Read,Edit,Write,Glob,Grep' : 'Read,Glob,Grep',
      ...(model && model !== 'default' ? ['--model', model] : []),
    ],
    parse(stdout) {
      const j = lastJson(stdout);
      if (!j) return { text: '', inputTokens: 0, outputTokens: 0, error: 'no JSON result from claude' };
      const u = j.usage ?? {};
      const text = typeof j.result === 'string' ? j.result : '';
      return {
        text,
        inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
        outputTokens: Number(u.output_tokens ?? 0),
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
        error: j.is_error ? text || j.subtype || 'claude returned an error' : undefined,
      };
    },
    loginArgs: ['auth', 'login'],
    env(account) {
      // Without a key the subscription login in the profile folder is used.
      // With a key and base URL this drives a coding plan (GLM, Kimi, MiniMax...) through Claude Code.
      const key = resolveKey(account);
      return {
        ANTHROPIC_API_KEY: key && !account.baseUrl ? key : undefined,
        ANTHROPIC_AUTH_TOKEN: key && account.baseUrl ? key : undefined,
        ANTHROPIC_BASE_URL: account.baseUrl,
      };
    },
  },

  gemini: {
    id: 'gemini',
    command: 'gemini',
    profileEnv: 'GEMINI_CLI_HOME',
    args: ({ model, edit }) => [
      '-p', 'Follow the instructions given on standard input.',
      '--output-format', 'json',
      '--approval-mode', edit ? 'auto_edit' : 'default',
      ...(model && model !== 'default' ? ['-m', model] : []),
    ],
    parse: parseGeminiStyle,
    loginArgs: [],
    env: (account) => ({ GEMINI_API_KEY: resolveKey(account) }),
  },

  qwen: {
    id: 'qwen',
    command: 'qwen',
    profileEnv: 'HOME',
    args: ({ model, edit }) => [
      '-p', 'Follow the instructions given on standard input.',
      '--output-format', 'json',
      // Qwen Code spells this mode "auto-edit"; Gemini CLI spells it "auto_edit"
      '--approval-mode', edit ? 'auto-edit' : 'default',
      ...(model && model !== 'default' ? ['-m', model] : []),
    ],
    parse: parseGeminiStyle,
    loginArgs: [],
    env: (account) => ({ OPENAI_API_KEY: resolveKey(account), OPENAI_BASE_URL: account.baseUrl }),
  },

  agy: {
    id: 'agy',
    command: 'agy',
    profileEnv: 'HOME',
    // Antigravity has no --approval-mode; its documented --mode accept-edits lets a code task change files
    args: ({ model, edit }) => [
      '-p', 'Follow the instructions given on standard input.',
      '--output-format', 'json',
      ...(edit ? ['--mode', 'accept-edits'] : []),
      ...(model && model !== 'default' ? ['--model', model] : []),
    ],
    parse: parseGeminiStyle,
    loginArgs: [],
  },

  opencode: {
    id: 'opencode',
    command: 'opencode',
    profileEnv: 'HOME',
    // JSON events carry the token counts and any error; the prompt arrives on stdin
    args: ({ model }) => ['run', '--format', 'json', ...(model && model !== 'default' ? ['--model', model] : [])],
    parse: (stdout) => parseOpenCode(stdout),
    loginArgs: ['auth', 'login'],
  },
};

/**
 * OpenCode's `run --format json` prints one event per line. Every finished step reports its tokens and cost;
 * cached reads count as input and thinking as output. An "error" event carries the provider's message.
 * Output without events (an OpenCode too old for --format) is taken as the answer itself.
 */
export function parseOpenCode(stdout: string): { text: string; inputTokens: number; outputTokens: number; costUsd?: number; error?: string } {
  const events = lines(stdout).filter((e) => e && typeof e.type === 'string');
  if (!events.length) return { text: stdout.trim(), inputTokens: 0, outputTokens: 0 };
  const texts: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let error: string | undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  for (const e of events) {
    if (e.type === 'text' && typeof e.part?.text === 'string' && e.part.text.trim()) texts.push(e.part.text.trim());
    if (e.type === 'step_finish') {
      const k = e.part?.tokens ?? {};
      inputTokens += n(k.input) + n(k.cache?.read) + n(k.cache?.write);
      outputTokens += n(k.output) + n(k.reasoning);
      cost += n(e.part?.cost);
    }
    if (e.type === 'error') error = String(e.error?.data?.message ?? e.error?.message ?? e.error?.name ?? 'error');
  }
  return { text: texts.join('\n\n'), inputTokens, outputTokens, ...(cost ? { costUsd: cost } : {}), ...(error ? { error } : {}) };
}

/** The JSON answer: Qwen Code prints one list of messages, ending in the "result"; others print objects. */
function answerJson(stdout: string): any {
  const t = stdout.trim();
  if (t.startsWith('[')) {
    try {
      const all = JSON.parse(t);
      if (Array.isArray(all)) return [...all].reverse().find((m) => m?.type === 'result') ?? all.at(-1);
    } catch {
      // not one JSON list; read it line by line below
    }
  }
  return lastJson(stdout);
}

function parseGeminiStyle(stdout: string) {
  const j = answerJson(stdout);
  if (!j) return { text: stdout.trim(), inputTokens: 0, outputTokens: 0 };
  let inputTokens = Number(j.usage?.input_tokens ?? 0);
  let outputTokens = Number(j.usage?.output_tokens ?? 0);
  const models = j.stats?.models;
  if (models && typeof models === 'object') {
    for (const m of Object.values<any>(models)) {
      inputTokens += Number(m?.tokens?.prompt ?? m?.tokens?.input ?? 0);
      outputTokens += Number(m?.tokens?.candidates ?? m?.tokens?.output ?? 0);
    }
  }
  const text = typeof j.response === 'string' ? j.response : typeof j.result === 'string' ? j.result : '';
  const error = j.error ? (typeof j.error === 'string' ? j.error : j.error.message ?? 'error') : j.status && j.status !== 'success' && !text ? String(j.status) : undefined;
  return { text, inputTokens, outputTokens, error };
}

export interface Resolved {
  file: string;
  prefix: string[];
  shell: boolean;
}

/** Find how to start a command. On Windows, npm installs ".cmd" shims; we run the script inside with node directly. */
export function resolveCommand(command: string): Resolved | undefined {
  if (process.platform !== 'win32') {
    const r = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
    const found = r.stdout?.trim();
    return found ? { file: found, prefix: [], shell: false } : undefined;
  }
  const r = spawnSync('where', [command], { encoding: 'utf8' });
  // `where` looks in the current folder before PATH, so a cloned repo could plant its own codex.cmd.
  const cwd = path.resolve(process.cwd()).toLowerCase();
  const hits = (r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .filter((h) => path.dirname(path.resolve(h)).toLowerCase() !== cwd);
  const exe = hits.find((h) => /\.exe$/i.test(h));
  if (exe) return { file: exe, prefix: [], shell: false };
  const cmd = hits.find((h) => /\.cmd$/i.test(h));
  if (!cmd) return undefined;
  try {
    const shim = fs.readFileSync(cmd, 'utf8');
    const m = shim.match(/"%dp0%\\([^"]+\.(?:js|cjs|mjs))"/i);
    if (m) {
      const script = path.resolve(path.dirname(cmd), m[1]!);
      if (fs.existsSync(script)) return { file: process.execPath, prefix: [script], shell: false };
    }
  } catch {
    /* fall back to the shell */
  }
  return { file: cmd, prefix: [], shell: true };
}

/** Text without the escape sequences that terminals use for colours, cursor moves and titles. */
export function stripTerminalCodes(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g, '');
}

export interface Launch {
  file: string;
  args: string[];
  /** pass the arguments to Windows exactly as given (they are quoted already) */
  verbatim: boolean;
  /** variables the program needs on top of its own environment */
  env: Record<string, string>;
  /** set when the program cannot be started safely with these arguments */
  error?: string;
}

/**
 * How to start a resolved program. A .cmd program needs cmd.exe: omnitrix starts cmd.exe itself, from an
 * absolute path, with a fixed command text in which the program path arrives in a variable and every
 * argument is quoted, so spaces and & | < > stay text. Inside quotes cmd.exe still reads " and %, so an
 * argument with either, or with a line break, is refused rather than run; /v:off keeps ! as text.
 */
export function launch(resolved: Resolved, args: string[]): Launch {
  const all = [...resolved.prefix, ...args];
  // Windows looks for programs in the current folder first, which may be a worker's folder
  const base: Record<string, string> = process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {};
  if (!resolved.shell) return { file: resolved.file, args: all, verbatim: false, env: base };
  if (all.some((a) => /["%\r\n]/.test(a))) {
    return { file: '', args: [], verbatim: true, env: {}, error: 'an argument contains a quotation mark, a percent sign or a line break, which cmd.exe could read as part of a command' };
  }
  const line = ['%OMNITRIX_PROGRAM%', ...all].map((a) => `"${a}"`).join(' ');
  const comspec = process.env.ComSpec && path.isAbsolute(process.env.ComSpec) ? process.env.ComSpec : path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return { file: comspec, args: ['/d', '/v:off', '/s', '/c', `"${line}"`], verbatim: true, env: { ...base, OMNITRIX_PROGRAM: resolved.file } };
}

export function profileEnv(tool: CliTool, dir: string): Record<string, string> {
  if (tool.profileEnv === 'HOME') return { HOME: dir, USERPROFILE: dir };
  return { [tool.profileEnv]: dir };
}

// Names that hold a secret: an agent CLI runs what a prompt tells it to, so it must never see them.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|_AUTH|AUTH_|COOKIE|SESSION_ID)/i;
// Settings that would point a CLI at the parent's provider or session instead of the account's own login.
const PARENT_SETTING = /^(.*_BASE_URL|CLAUDECODE|CLAUDE_CODE_.*|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|CODEX_HOME|GEMINI_CLI_.*)$/i;

/**
 * The environment for an agent CLI: the parent's, without anything that looks like a credential or a
 * provider setting, then the tool's own variables (its profile folder, or the account's own key).
 */
export function childEnv(parent: Record<string, string | undefined>, toolEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    // a database address or proxy setting can carry a password inside it, such as postgres://user:pw@host
    if (v === undefined || SECRET_NAME.test(k) || PARENT_SETTING.test(k) || /:\/\/[^/\s:@]*:[^/\s@]+@/.test(v)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(toolEnv)) if (v !== undefined) env[k] = v;
  return env;
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export function classifyCliError(text: string): ErrorKind {
  const t = text.toLowerCase();
  // a prompt that is too long is the task's problem, wherever it ran
  if (/(context length|context window|too many tokens|prompt is too long|maximum.{0,20}tokens)/.test(t)) return 'bad_request';
  // "rate limit exceeded" is a short wait, not a used-up plan, so it is checked first
  if (/(rate limit|rate-limit|too many requests|\b429\b)/.test(t)) return 'rate_limit';
  // "insufficient permissions" is a login problem, not a used-up plan. A bare "permission denied" or a file
  // called login.ts is not: an agent that could not write a file must not take the account out of the pool.
  if (/(not logged in|log ?in again|run \S*login|please (log ?in|sign in)|unauthori[sz]ed|\b401\b|\b403\b|authenticat|(invalid|incorrect|missing|no) api key|api key (is )?(invalid|missing|not valid)|insufficient permissions)/.test(t)) return 'auth';
  if (/(usage limit|quota|exceeded|out of credits|insufficient|limit reached|hit your limit)/.test(t)) return 'quota';
  return 'unknown';
}

const MAX_OUTPUT = 20 * 1024 * 1024;

/** Whether a task on this account runs as an agent in a folder (an agent CLI, or OpenCode for an API account's code task). */
export function runsAsAgent(account: Account, edit: boolean): boolean {
  return account.driver === 'cli' || (edit && account.driver === 'openai');
}

/** OpenCode is installed, so API accounts can do code tasks. */
export function apiAgentInstalled(): boolean {
  return resolveCommand('opencode') !== undefined;
}

/**
 * Which adapter OpenCode uses for an account. Most providers speak the OpenAI format, but Gemini's
 * OpenAI-compatible endpoint loses the "thought signatures" that Gemini 3 needs between tool calls, so a
 * Gemini account goes through Google's own adapter, at the same API without "/openai" and without "models/".
 */
export function agentProvider(baseUrl: string, model: string): { npm: string; baseURL: string; model: string } {
  let host = '';
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    // not a URL; the OpenAI format is tried and the provider's error says the rest
  }
  if (host === 'generativelanguage.googleapis.com') {
    return { npm: '@ai-sdk/google', baseURL: baseUrl.replace(/\/openai\/?$/, ''), model: model.replace(/^models\//, '') };
  }
  return { npm: '@ai-sdk/openai-compatible', baseURL: baseUrl, model };
}

/**
 * A code task on an API account: OpenCode does the agent's work (reading, editing, running commands) and
 * omnitrix gives it a config that names one provider, this account's endpoint and the chosen model, so nothing
 * else is loaded and titles and summaries go to the same model. The key travels in its own variable, never in
 * the config, and OpenCode gets a home folder of its own, so the user's own OpenCode setup and MCP servers stay out.
 */
export async function runApiAgent(req: DriverRequest): Promise<DriverResult> {
  const { account, model } = req;
  if (account.driver !== 'openai' || !account.baseUrl) throw new DriverError(`account ${account.id} cannot run code tasks through OpenCode`, 'bad_request');
  if (!model || !SAFE_ARG.test(model)) throw new DriverError(`unsafe model name: ${model}`, 'bad_request');
  const key = resolveKey(account);
  const sdk = agentProvider(account.baseUrl, model);
  const id = `omnitrix/${sdk.model}`;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      omnitrix: {
        npm: sdk.npm,
        name: `omnitrix: ${account.id}`,
        options: { baseURL: sdk.baseURL, apiKey: '{env:OMNITRIX_WORKER_KEY}' },
        models: { [sdk.model]: { name: sdk.model } },
      },
    },
    model: id,
    small_model: id,
    enabled_providers: ['omnitrix'],
    share: 'disabled',
    autoupdate: false,
  };
  const home = path.join(files.profiles(), '.api-agent');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const tool = CLI_TOOLS.opencode!;
  return runCli({ ...req, model: id }, true, {
    tool,
    env: { ...profileEnv(tool, home), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OMNITRIX_WORKER_KEY: key ?? 'none' },
  });
}

// Codex features whose tools a worker never needs: browsers, computer use, apps and plugins, image
// generation, sub-agents, goals and skill search. Their tool descriptions ride along with every request;
// turning them off took a one-word answer from about 25,000 input tokens to about 13,800 (codex-cli
// 0.167.1). The shell, file edits and view_image stay, so code tasks and pictures in a repo still work.
const LEAN_OFF = [
  'apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'browser_annotation_api', 'in_app_browser', 'computer_use', 'image_generation',
  'multi_agent', 'goals', 'skill_search', 'tool_suggest', 'sleep_tool',
];

/** Feature names from the table that `codex features list` prints, without removed ones. */
export function readFeatureList(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z][a-z0-9_]*)\s+(.+?)\s+(true|false)\s*$/.exec(line.trim());
    if (m && m[2] !== 'removed') names.add(m[1]!);
  }
  return names;
}

/** The extra features to turn off: only names this Codex lists, so a renamed feature is simply skipped. */
export function leanFeatures(listed: Set<string>): string[] {
  return LEAN_OFF.filter((f) => listed.has(f));
}

const featureCache = new Map<string, Promise<Set<string>>>();

/** Forget the feature lists read so far, such as after Codex was updated. */
export function forgetCodexFeatures(): void {
  featureCache.clear();
}

/** What `codex features list` reports, read once per program; an empty set when it cannot be read. */
function codexFeatures(resolved: Resolved, env: Record<string, string>): Promise<Set<string>> {
  const key = [resolved.file, ...resolved.prefix].join('|');
  let found = featureCache.get(key);
  if (!found) {
    found = new Promise<Set<string>>((done) => {
      const start = launch(resolved, ['features', 'list']);
      if (start.error) return done(new Set());
      let out = '';
      let child: ReturnType<typeof spawn>;
      try {
        // from the temp folder: the current one may be a repository, and Windows looks for programs there first
        child = spawn(start.file, start.args, { cwd: os.tmpdir(), env: { ...env, ...start.env } as NodeJS.ProcessEnv, windowsVerbatimArguments: start.verbatim, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return done(new Set());
      }
      const timer = setTimeout(() => {
        killTree(child.pid);
        done(new Set());
      }, 15_000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => {
        if (out.length < 256 * 1024) out += d;
      });
      child.on('error', () => {
        clearTimeout(timer);
        done(new Set());
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0 ? readFeatureList(out) : new Set());
      });
    });
    featureCache.set(key, found);
  }
  return found;
}

/**
 * How long a tool that reports its start at once may stay silent before omnitrix stops it: two minutes, or
 * OMNITRIX_CLI_START_SEC. A healthy Codex prints its first event within a few seconds; once it has started,
 * it may think in silence until the job's own limit. Other tools print only at the end, so they get none.
 */
export function cliStartLimitMs(tool: CliTool): number | undefined {
  if (!tool.reportsStart) return undefined;
  const sec = Number(process.env.OMNITRIX_CLI_START_SEC);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 120_000;
}

export async function runCli(req: DriverRequest, edit: boolean, via?: { tool: CliTool; env: Record<string, string> }): Promise<DriverResult> {
  const { account } = req;
  // an abort listener added now would never fire for a job that was already cancelled
  if (req.signal?.aborted) throw new DriverError('cancelled', 'cancelled');
  const tool = via?.tool ?? CLI_TOOLS[providerTool(account.provider)];
  if (!tool) throw new DriverError(`unknown CLI tool for provider ${account.provider}`, 'bad_request');
  if (req.model && !SAFE_ARG.test(req.model)) throw new DriverError(`unsafe model name: ${req.model}`, 'bad_request');

  const resolved = resolveCommand(tool.command);
  if (!resolved) throw new DriverError(`"${tool.command}" is not installed or not on PATH`, 'auth');

  const tempCwd = req.cwd ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-'));
  const cwd = req.cwd ?? tempCwd!;
  const outFile = path.join(os.tmpdir(), `omnitrix-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const profile = account.profileDir ? profileEnv(tool, account.profileDir) : {};
  const off = tool.id === 'codex' && !via && req.lean ? leanFeatures(await codexFeatures(resolved, childEnv(process.env, profile))) : [];
  if (req.signal?.aborted) {
    if (tempCwd) fs.rmSync(tempCwd, { recursive: true, force: true });
    throw new DriverError('cancelled', 'cancelled');
  }
  const start = launch(resolved, tool.args({ model: req.model, edit, cwd, outFile, effort: req.effort, off }));
  if (start.error) {
    if (tempCwd) fs.rmSync(tempCwd, { recursive: true, force: true });
    throw new DriverError(`cannot start ${tool.command} safely: ${start.error}`, 'bad_request');
  }

  // never let the parent's keys leak into a worker, which may run whatever a prompt asks
  const env = childEnv(process.env, via ? { ...via.env, ...start.env } : { ...profile, ...(tool.env?.(account) ?? {}), ...start.env });
  // some tools (OpenCode among them) take their folder from PWD, which still names the parent's folder
  env.PWD = cwd;

  const fullPrompt = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;

  return await new Promise<DriverResult>((resolve, reject) => {
    const child = spawn(start.file, start.args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      windowsVerbatimArguments: start.verbatim,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      fs.rm(outFile, { force: true }, () => {});
      if (tempCwd) fs.rm(tempCwd, { recursive: true, force: true }, () => {});
      fn();
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(() => reject(new DriverError(`${tool.command} did not finish in ${Math.round(req.timeoutMs / 1000)}s`, 'timeout')));
    }, req.timeoutMs);
    const onAbort = () => {
      killTree(child.pid);
      finish(() => reject(new DriverError('cancelled', 'cancelled')));
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const startLimit = cliStartLimitMs(tool);
    const silentStart = startLimit === undefined ? undefined : setTimeout(() => {
      killTree(child.pid);
      finish(() => reject(new DriverError(`${tool.command} printed nothing in ${Math.round(startLimit / 1000)} s after it started, so it was stopped`, 'timeout')));
    }, startLimit);
    child.on('close', () => clearTimeout(silentStart));

    // decoded as one stream, so a character split across two chunks stays whole
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      clearTimeout(silentStart);
      // the tools write their result and token counts last, so a very long output keeps its end
      stdout += d;
      if (stdout.length > 2 * MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT);
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < 200_000) stderr += d;
    });
    child.on('error', (err) => finish(() => reject(new DriverError(`cannot start ${tool.command}: ${err.message}`, 'network'))));
    child.on('close', (code) => {
      // read the -o file before finish() deletes it
      let parsed: ReturnType<CliTool['parse']>;
      try {
        parsed = tool.parse(stdout, outFile);
      } catch (err) {
        parsed = { text: '', inputTokens: 0, outputTokens: 0, error: String(err) };
      }
      finish(() => {
        // an agent that edited files may finish without a closing message; the diff is the result then
        const editedQuietly = edit && code === 0 && !parsed.error;
        // text from a tool that then crashed may be cut off, so only a clean exit counts
        if ((parsed.text && !parsed.error && code === 0) || editedQuietly) {
          resolve({ text: parsed.text || '(no summary from the agent; see the diff)', inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, costUsd: parsed.costUsd });
          return;
        }
        const detail = redact(stripTerminalCodes((parsed.error ?? '') + '\n' + stderr.slice(-1500) + (parsed.text ? '' : '\n' + stdout.slice(-500)))).trim();
        reject(new DriverError(`${tool.command} exited with code ${code}: ${detail || 'no output'}`, classifyCliError(detail)));
      });
    });
    child.stdin.on('error', () => {
      /* the tool may exit before reading stdin; the close handler reports it */
    });
    child.stdin.end(fullPrompt);
  });
}

/** Which CLI tool a provider runs, from the provider catalog. */
export function providerTool(provider: string): string {
  return getProvider(provider)?.cli ?? provider;
}

/** Run the tool's own login inside the account's profile folder, in this terminal. */
export function loginCli(account: Account): number {
  const tool = CLI_TOOLS[providerTool(account.provider)];
  if (!tool) throw new Error(`unknown CLI tool for provider ${account.provider}`);
  const resolved = resolveCommand(tool.command);
  if (!resolved) throw new Error(`"${tool.command}" is not installed or not on PATH`);
  const start = launch(resolved, tool.loginArgs);
  if (start.error) throw new Error(`cannot start ${tool.command} safely: ${start.error}`);
  const env = childEnv(process.env, { ...(account.profileDir ? profileEnv(tool, account.profileDir) : {}), ...start.env });
  const r = spawnSync(start.file, start.args, { stdio: 'inherit', env, windowsVerbatimArguments: start.verbatim });
  return r.status ?? 1;
}
