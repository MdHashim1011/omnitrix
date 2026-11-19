// omnitrix's own check of a code job: which files changed, whether the task named them, and whether
// the task's test command passes. It is plain fact for Claude's review, not a verdict.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, killTree, launch, resolveCommand, stripTerminalCodes, type Resolved } from './drivers/cli.js';
import { redact } from './store.js';
import type { JobVerify, TaskSpec } from './types.js';

const MAX_OUTPUT = 4000;

/** Path as git prints it: relative to the repository, with forward slashes. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** The changed files that the task did not name. A named folder ("src/" or "src") covers what is inside it. */
export function outsideFiles(changed: string[], task: TaskSpec, repoRoot: string): string[] | undefined {
  if (!task.files?.length) return undefined;
  const named = task.files.map((f) => norm(path.isAbsolute(f) ? path.relative(repoRoot, f) : f));
  return changed.filter((c) => !named.some((n) => c === n || c.startsWith(`${n}/`)));
}

/**
 * How to start the test program. The name comes from the task, and resolveCommand hands it to a shell on
 * macOS and Linux, so only a plain program name or an existing absolute path is accepted. A name found
 * through a relative PATH entry such as "." would come from the worker's folder, so it is refused too.
 */
function findProgram(name: string): Resolved | undefined {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? { file: name, prefix: [], shell: /\.(cmd|bat)$/i.test(name) } : undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  const found = resolveCommand(name);
  return found && path.isAbsolute(found.file) ? found : undefined;
}

/**
 * The test's environment: no secrets by name or inside addresses, and a home folder of its own, so code
 * that looks for logins under the home folder finds none. This is not a sandbox; the code can still open
 * any file by its full path.
 */
function testEnv(home: string, extra: Record<string, string>): Record<string, string> {
  return childEnv(process.env, {
    ...extra,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    // Windows looks for programs in the current folder first, which is the worker's folder here
    ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}),
  });
}

type TestResult = NonNullable<JobVerify['test']>;


/** Run the task's test command in the job's worktree, within `timeoutMs`; `signal` stops it early. */
export function runTest(command: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<TestResult> {
  const shown = command.join(' ');
  const t0 = Date.now();
  const refuse = (output: string): Promise<TestResult> => Promise.resolve({ command: shown, status: 'error', output, durationMs: 0 });
  const resolved = findProgram(command[0]!);
  if (!resolved) return refuse(`"${command[0]}" is not a program name or path that omnitrix can start`);
  // a .cmd program such as npm.cmd goes through cmd.exe, safely (see launch)
  const start = launch(resolved, command.slice(1));
  if (start.error) return refuse(start.error);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-test-home-'));
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (r: TestResult) => {
      if (settled) return;
      settled = true;
      fs.rmSync(home, { recursive: true, force: true });
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // keys are hidden before the output is cut, so a cut never splits one out of sight; the first,
      // possibly partial line is dropped
      // terminal colour and cursor codes mean nothing to Claude and only take up its context
      let text = redact(stripTerminalCodes(r.output ?? ''));
      if (text.length > MAX_OUTPUT) text = text.slice(-MAX_OUTPUT).replace(/^[^\n]*\n/, '');
      resolve({ ...r, output: text, durationMs: Date.now() - t0 });
    };
    let stopped: string | undefined;
    const timer = setTimeout(() => {
      stopped = `stopped after ${Math.round(timeoutMs / 1000)} s`;
      killTree(child?.pid);
    }, timeoutMs);
    const onAbort = () => {
      stopped = 'cancelled';
      killTree(child?.pid);
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(start.file, start.args, { cwd, env: testEnv(home, start.env), windowsVerbatimArguments: start.verbatim, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ command: shown, status: 'error', output: `cannot start ${command[0]}: ${err instanceof Error ? err.message : err}` });
      return;
    }
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const keep = (d: string) => {
      out = (out + d).slice(-MAX_OUTPUT * 4);
    };
    // decoded as one stream, so a character split across two chunks stays whole
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    child.on('error', (err) => finish({ command: shown, status: 'error', output: `cannot start ${command[0]}: ${err.message}` }));
    child.on('close', (code) => {
      if (stopped) return finish({ command: shown, status: 'error', output: `${out}\n${stopped}` });
      finish({ command: shown, status: code === 0 ? 'passed' : 'failed', exitCode: code ?? undefined, output: out });
    });
  });
}

/** Seconds as both the summary and get_results show them: whole seconds, at least 1. */
export function testSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

/** One line for Claude and the dashboard, such as "changed 2 files, all named in the task; tests passed (npm test, 4 s)". */
export function verifySummary(v: JobVerify): string {
  const n = v.files.length;
  const parts = [n ? `changed ${n} file${n === 1 ? '' : 's'}` : 'changed no files'];
  if (v.outside) parts[0] += v.outside.length ? `; ${v.outside.length} not named in the task: ${v.outside.slice(0, 5).join(', ')}${v.outside.length > 5 ? ', ...' : ''}` : n ? ', all named in the task' : '';
  const t = v.test;
  if (t) {
    const took = t.durationMs !== undefined ? `, ${testSeconds(t.durationMs)} s` : '';
    const why = t.exitCode === undefined ? 'stopped by a signal' : `exit code ${t.exitCode}`;
    parts.push(
      t.status === 'running' ? `tests running (${t.command})`
        : t.status === 'passed' ? `tests passed (${t.command}${took})`
        : t.status === 'failed' ? `tests failed (${why}, ${t.command}${took})`
        : t.status === 'interrupted' ? `tests interrupted (${t.command})`
        : `tests could not run (${t.command})`,
    );
  }
  return parts.join('; ');
}
