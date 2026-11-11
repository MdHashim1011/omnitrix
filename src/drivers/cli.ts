import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProvider } from '../providers.js';
import { redact, resolveKey } from '../store.js';
import { DriverError, type Account, type DriverRequest, type DriverResult, type ErrorKind } from '../types.js';

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
  args(opts: { model?: string; edit: boolean; cwd: string; outFile: string }): string[];
  parse(stdout: string, outFile: string): { text: string; inputTokens: number; outputTokens: number; costUsd?: number; error?: string };
  loginArgs: string[];
  /** extra env for a run */
  env?(account: Account): Record<string, string | undefined>;
  /** prepare a fresh profile folder */
  initProfile?(dir: string): void;
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

export const CLI_TOOLS: Record<string, CliTool> = {
  codex: {
    id: 'codex',
    command: 'codex',
    profileEnv: 'CODEX_HOME',
    args: ({ model, edit, cwd, outFile }) => [
      'exec', '--json', '--skip-git-repo-check', '--ephemeral',
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
          outputTokens += Number(e.usage.output_tokens ?? 0) + Number(e.usage.reasoning_output_tokens ?? 0);
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
      '-p', '--output-format', 'json', '--permission-prompts', 'none',
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
      '--approval-mode', edit ? 'auto_edit' : 'default',
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
    args: ({ model }) => ['-p', 'Follow the instructions given on standard input.', '--output-format', 'json', ...(model && model !== 'default' ? ['--model', model] : [])],
    parse: parseGeminiStyle,
    loginArgs: [],
  },

  opencode: {
    id: 'opencode',
    command: 'opencode',
    profileEnv: 'HOME',
    args: ({ model }) => ['run', ...(model && model !== 'default' ? ['-m', model] : [])],
    parse: (stdout) => ({ text: stdout.trim(), inputTokens: 0, outputTokens: 0 }),
    loginArgs: ['auth', 'login'],
  },
};

function parseGeminiStyle(stdout: string) {
  const j = lastJson(stdout);
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

export function profileEnv(tool: CliTool, dir: string): Record<string, string> {
  if (tool.profileEnv === 'HOME') return { HOME: dir, USERPROFILE: dir };
  return { [tool.profileEnv]: dir };
}

/** Keys that would make an agent CLI use the parent's credentials instead of the account's own login. */
export const PARENT_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

function classifyCliError(text: string): ErrorKind {
  const t = text.toLowerCase();
  if (/(usage limit|quota|exceeded|out of credits|insufficient|limit reached|hit your limit)/.test(t)) return 'quota';
  if (/(rate limit|too many requests|429)/.test(t)) return 'rate_limit';
  if (/(not logged in|login|unauthori[sz]ed|401|403|authenticat|api key)/.test(t)) return 'auth';
  return 'unknown';
}

const MAX_OUTPUT = 20 * 1024 * 1024;

export async function runCli(req: DriverRequest, edit: boolean): Promise<DriverResult> {
  const { account } = req;
  const tool = CLI_TOOLS[providerTool(account.provider)];
  if (!tool) throw new DriverError(`unknown CLI tool for provider ${account.provider}`, 'bad_request');
  if (req.model && !SAFE_ARG.test(req.model)) throw new DriverError(`unsafe model name: ${req.model}`, 'bad_request');

  const resolved = resolveCommand(tool.command);
  if (!resolved) throw new DriverError(`"${tool.command}" is not installed or not on PATH`, 'auth');

  const tempCwd = req.cwd ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-'));
  const cwd = req.cwd ?? tempCwd!;
  const outFile = path.join(os.tmpdir(), `omnitrix-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const rawArgs = [...resolved.prefix, ...tool.args({ model: req.model, edit, cwd, outFile })];
  // only used when we had to fall back to cmd.exe; quote anything with spaces
  const args = resolved.shell ? rawArgs.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '')}"` : a)) : rawArgs;

  const env: Record<string, string | undefined> = { ...process.env };
  // never let the parent's keys leak into an account that should use its own login
  for (const k of PARENT_CREDENTIALS) delete env[k];
  if (account.profileDir) Object.assign(env, profileEnv(tool, account.profileDir));
  for (const [k, v] of Object.entries(tool.env?.(account) ?? {})) if (v !== undefined) env[k] = v;

  const fullPrompt = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt;

  return await new Promise<DriverResult>((resolve, reject) => {
    const child = spawn(resolved.file, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      shell: resolved.shell,
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

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 200_000) stderr += d.toString('utf8');
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
        if ((parsed.text && !parsed.error) || editedQuietly) {
          resolve({ text: parsed.text || '(no summary from the agent; see the diff)', inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, costUsd: parsed.costUsd });
          return;
        }
        const detail = redact((parsed.error ?? '') + '\n' + stderr.slice(-1500) + (parsed.text ? '' : '\n' + stdout.slice(-500))).trim();
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
  const env = { ...process.env, ...(account.profileDir ? profileEnv(tool, account.profileDir) : {}) };
  const r = spawnSync(resolved.file, [...resolved.prefix, ...tool.loginArgs], { stdio: 'inherit', env, shell: resolved.shell });
  return r.status ?? 1;
}
