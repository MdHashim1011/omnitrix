// Runs jobs: picks an account for each task, starts it, and hands it to the next account when one fails.
// Job records are kept on disk so the dashboard and other omnitrix processes can see them.
import fs from 'node:fs';
import path from 'node:path';
import { runDriver } from './drivers/index.js';
import { route, effectivePrivacy, type Candidate, type Rejected, type RouteContext } from './router.js';
import { loadStats, recordVerdict } from './stats.js';
import { ensureHome, files, findAccount, loadConfig, loadHealth, readJson, redact, saveHealth, writeJson } from './store.js';
import { DriverError, type Account, type AccountHealth, type Config, type Job, type TaskSpec } from './types.js';
import { compactLedger, readLedger, recordUsage, summarize, type UsageSummary } from './usage.js';
import { createWorktree, discardWorktree, finishWorktree, isGitRepo } from './worktree.js';

const MAX_ATTEMPTS = 3;
const MAX_FILE_BYTES = 400_000;

const WORKER_SYSTEM = [
  'You are one worker in a team. A lead engineer split a larger job and gave you this part.',
  'Do exactly this part, completely, and nothing outside it.',
  'Reply with the result only: no greeting, no restating the task, no notes about these instructions.',
].join('\n');

const EDIT_RULES = [
  'You are working in a git checkout made just for this task. Change only what the task needs.',
  'When you finish, list the files you changed and one line on why for each.',
  'If something blocks you, say exactly what is missing instead of guessing.',
].join('\n');

export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export interface PoolAccountView {
  id: string;
  label: string;
  owner: string;
  provider: string;
  driver: string;
  enabled: boolean;
  state: AccountHealth['state'];
  until?: number;
  reason?: string;
  running: number;
  models: string[];
  usage: UsageSummary;
  local: boolean;
}

export class Engine {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private running: Record<string, number> = {};
  private health: Record<string, AccountHealth>;
  private usageCache?: { at: number; records: ReturnType<typeof readLedger> };
  private listeners = new Set<() => void>();

  constructor() {
    ensureHome();
    compactLedger();
    this.health = loadHealth();
    this.recoverJobs();
  }

  /**
   * Jobs left unfinished by a process that has since stopped can never finish; mark them so Claude is not left waiting.
   * Jobs owned by another process that is still alive (an MCP server, a dashboard, a CLI run) are left alone.
   */
  private recoverJobs(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(files.jobs());
    } catch {
      return;
    }
    const cutoff = Date.now() - 3 * 24 * 3600_000;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const job = readJson<Job | null>(path.join(files.jobs(), name), null);
      if (!job) continue;
      if (job.updatedAt < cutoff) continue;
      if ((job.status === 'queued' || job.status === 'running') && !processAlive(job.pid)) {
        job.status = 'failed';
        job.error = 'interrupted: the omnitrix server stopped before this job finished';
        job.updatedAt = Date.now();
        this.saveJob(job);
      }
      this.jobs.set(job.id, job);
    }
  }

  config(): Config {
    return loadConfig();
  }

  private records() {
    const now = Date.now();
    if (!this.usageCache || now - this.usageCache.at > 2000) {
      this.usageCache = { at: now, records: readLedger(now - 32 * 24 * 3600_000) };
    }
    return this.usageCache.records;
  }

  private routeContext(cfg: Config): RouteContext {
    const records = this.records();
    // another process (a CLI "set" or "test", a second server) may have seen the account more recently
    for (const [id, h] of Object.entries(loadHealth())) {
      if ((h.at ?? 0) > (this.health[id]?.at ?? 0)) this.health[id] = h;
    }
    const usage: Record<string, UsageSummary> = {};
    for (const a of cfg.accounts) usage[a.id] = summarize(a, records, this.health[a.id]);
    return { config: cfg, health: this.health, usage, running: this.running, stats: loadStats() };
  }

  pool(): PoolAccountView[] {
    const cfg = this.config();
    const ctx = this.routeContext(cfg);
    const now = Date.now();
    return cfg.accounts.map((a) => {
      const h = this.health[a.id];
      let state: AccountHealth['state'] = a.enabled ? 'ready' : 'disabled';
      if (a.enabled && h && h.state !== 'ready' && h.state !== 'busy') {
        const expired = (h.state === 'cooling' || h.state === 'exhausted' || h.state === 'offline') && (h.until ?? 0) <= now;
        if (!expired) state = h.state;
      }
      if (state === 'ready' && (this.running[a.id] ?? 0) > 0) state = 'busy';
      if (state === 'ready' && ctx.usage[a.id]!.percentUsed === 100) state = 'exhausted';
      return {
        id: a.id,
        label: a.label,
        owner: a.owner,
        provider: a.provider,
        driver: a.driver,
        enabled: a.enabled,
        state,
        until: h?.until && h.until > now ? h.until : undefined,
        reason: state === 'ready' || state === 'busy' ? undefined : h?.reason,
        running: this.running[a.id] ?? 0,
        models: a.models.map((m) => m.id),
        usage: ctx.usage[a.id]!,
        local: a.local,
      };
    });
  }

  preview(task: TaskSpec): { candidates: Candidate[]; rejected: Rejected[] } {
    const cfg = this.config();
    return route(task, this.routeContext(cfg));
  }

  /** Throws before queuing anything if a task can never run. */
  dispatch(tasks: TaskSpec[]): Job[] {
    for (const t of tasks) {
      // without a repo the agent would edit a temp folder that is deleted afterwards
      if (t.type === 'code' && !t.repo) throw new Error(`task "${t.title}": code tasks need "repo", the absolute path of a git repository`);
    }
    const now = Date.now();
    const created = tasks.map((task) => {
      const job: Job = { id: newId('j'), task, status: 'queued', createdAt: now, updatedAt: now, attempts: [], pid: process.pid };
      this.jobs.set(job.id, job);
      this.saveJob(job);
      return job;
    });
    this.pump();
    return created;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id) ?? readJson<Job | null>(path.join(files.jobs(), `${id}.json`), null) ?? undefined;
  }

  listJobs(limit = 50): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  /** Wait until all given jobs are finished or the time is up. */
  async wait(ids: string[], waitSec: number): Promise<Job[]> {
    const deadline = Date.now() + Math.max(0, waitSec) * 1000;
    const done = () => ids.every((id) => {
      const j = this.getJob(id);
      return !j || j.status === 'done' || j.status === 'failed' || j.status === 'cancelled';
    });
    while (!done() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(finish, Math.min(1000, Math.max(10, deadline - Date.now())));
        function finish() {
          clearTimeout(t);
          resolve();
        }
        this.listeners.add(finish);
        setTimeout(() => this.listeners.delete(finish), 1100);
      });
    }
    return ids.map((id) => this.getJob(id)).filter((j): j is Job => !!j);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return false;
    this.controllers.get(id)?.abort();
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      this.saveJob(job);
      this.notify();
    }
    return true;
  }

  verdict(id: string, accepted: boolean): Job | undefined {
    const job = this.getJob(id);
    if (!job || !job.model || job.status !== 'done') return undefined;
    job.verdict = accepted ? 'accepted' : 'rejected';
    recordVerdict(job.model, job.task.type, accepted);
    job.updatedAt = Date.now();
    this.jobs.set(job.id, job);
    this.saveJob(job);
    return job;
  }

  readOutput(id: string): string | undefined {
    const job = this.getJob(id);
    if (!job?.outputFile) return undefined;
    try {
      return fs.readFileSync(job.outputFile, 'utf8');
    } catch {
      return undefined;
    }
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private saveJob(job: Job): void {
    writeJson(path.join(files.jobs(), `${job.id}.json`), job);
  }

  private setHealth(accountId: string, h: AccountHealth): void {
    const stamped = { ...h, at: Date.now() };
    this.health[accountId] = stamped;
    saveHealth({ [accountId]: stamped });
  }

  /** Start every queued job that has a free account. */
  private pump(): void {
    const cfg = this.config();
    // only start our own jobs; another live process is responsible for its queue
    const queued = [...this.jobs.values()].filter((j) => j.status === 'queued' && j.pid === process.pid).sort((a, b) => a.createdAt - b.createdAt);
    for (const job of queued) {
      const ctx = this.routeContext(cfg);
      const tried = new Set(job.attempts.map((a) => a.accountId));
      const { candidates, rejected } = route(job.task, ctx);
      const fresh = candidates.filter((c) => !tried.has(c.accountId));
      const free = fresh.find((c) => {
        const acc = findAccount(cfg, c.accountId)!;
        return (this.running[c.accountId] ?? 0) < acc.concurrency;
      });
      if (free) {
        void this.start(job, free, cfg);
        continue;
      }
      if (fresh.length === 0) {
        job.status = 'failed';
        const lastError = job.attempts.at(-1)?.error;
        const reasons = rejected.slice(0, 8).map((r) => `${r.accountId}${r.model ? '/' + r.model : ''}: ${r.reason}`);
        job.error = lastError
          ? `all attempts failed. last error: ${lastError}`
          : `no account can take this task.${reasons.length ? ' ' + reasons.join('; ') : ' Add an account with "omnitrix add".'}`;
        job.updatedAt = Date.now();
        this.saveJob(job);
        this.notify();
      }
      // otherwise every suitable account is busy: stay queued, a finishing job calls pump() again
    }
  }

  private async start(job: Job, cand: Candidate, cfg: Config): Promise<void> {
    const account = findAccount(cfg, cand.accountId)!;
    this.running[account.id] = (this.running[account.id] ?? 0) + 1;
    const ctrl = new AbortController();
    this.controllers.set(job.id, ctrl);
    const attempt = { accountId: account.id, model: cand.model, startedAt: Date.now() } as Job['attempts'][number];
    job.attempts.push(attempt);
    job.status = 'running';
    job.accountId = account.id;
    job.model = cand.model;
    job.updatedAt = Date.now();
    this.saveJob(job);

    const t0 = Date.now();
    let worktree: { path: string; branch: string; root: string } | undefined;
    try {
      const edit = job.task.type === 'code';
      let cwd: string | undefined;
      if (job.task.repo) {
        if (!isGitRepo(job.task.repo)) throw new DriverError(`not a git repository: ${job.task.repo}`, 'bad_request');
        if (edit) {
          worktree = createWorktree(job.task.repo, job.id);
          cwd = worktree.path;
          job.worktree = { path: worktree.path, branch: worktree.branch };
        } else {
          cwd = job.task.repo;
        }
      }
      const prompt = buildPrompt(job.task, account, cwd);
      const result = await runDriver(
        {
          account,
          model: cand.model,
          system: edit ? `${WORKER_SYSTEM}\n${EDIT_RULES}` : WORKER_SYSTEM,
          prompt,
          cwd,
          timeoutMs: cfg.settings.jobTimeoutSec * 1000,
          signal: ctrl.signal,
          maxOutputTokens: account.driver === 'cli' ? undefined : job.task.size === 'small' ? 4000 : job.task.size === 'large' ? 32000 : 16000,
        },
        edit,
      );

      recordUsage({ ts: Date.now(), accountId: account.id, model: cand.model, jobId: job.id, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: true, latencyMs: Date.now() - t0, costUsd: result.costUsd });
      this.usageCache = undefined;
      const measured = result.rate ? { ...result.rate, at: Date.now(), source: 'response headers' } : this.health[account.id]?.measured;
      this.setHealth(account.id, { state: 'ready', measured });

      let text = result.text;
      if (worktree) {
        const fin = finishWorktree(worktree.path, `${job.task.title}\n\nomnitrix job ${job.id}`);
        job.worktree = { path: worktree.path, branch: worktree.branch, diffStat: fin.diffStat };
        text += `\n\n---\nbranch: ${worktree.branch}\n${fin.diffStat}`;
      }
      const outFile = path.join(files.outputs(), `${job.id}.md`);
      fs.writeFileSync(outFile, text);
      job.outputFile = outFile;
      job.outputChars = text.length;
      job.preview = text.slice(0, cfg.settings.resultPreviewChars);
      job.usage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd };
      job.status = 'done';
      job.error = undefined;
      attempt.ok = true;
    } catch (err) {
      const e = err instanceof DriverError ? err : new DriverError(err instanceof Error ? err.message : String(err), 'unknown');
      attempt.ok = false;
      attempt.error = redact(e.message).slice(0, 600);
      attempt.errorKind = e.kind;
      if (e.kind !== 'bad_request' && e.kind !== 'cancelled') {
        recordUsage({ ts: Date.now(), accountId: account.id, model: cand.model, jobId: job.id, inputTokens: 0, outputTokens: 0, ok: false, status: e.status, errorKind: e.kind, latencyMs: Date.now() - t0 });
        this.usageCache = undefined;
      }
      this.applyFailure(account, e);

      if (ctrl.signal.aborted || e.kind === 'cancelled') {
        job.status = 'cancelled';
        job.error = 'cancelled';
      } else if (job.attempts.length < MAX_ATTEMPTS && e.kind !== 'bad_request') {
        job.status = 'queued'; // pump() will try the next best account
        job.error = attempt.error;
      } else {
        job.status = 'failed';
        job.error = attempt.error;
      }
      if (worktree) {
        if (job.status === 'queued') {
          discardWorktree(worktree.root, worktree.path, worktree.branch);
          job.worktree = undefined;
        } else {
          job.worktree = { path: worktree.path, branch: worktree.branch, diffStat: 'failed' };
        }
      }
    } finally {
      attempt.endedAt = Date.now();
      this.running[account.id] = Math.max(0, (this.running[account.id] ?? 1) - 1);
      this.controllers.delete(job.id);
      job.updatedAt = Date.now();
      this.saveJob(job);
      this.notify();
      this.pump();
    }
  }

  private applyFailure(account: Account, e: DriverError): void {
    const now = Date.now();
    const prev = this.health[account.id];
    switch (e.kind) {
      case 'rate_limit':
        this.setHealth(account.id, { state: 'cooling', until: now + (e.retryAfterMs ?? 60_000), reason: 'rate limited', measured: prev?.measured });
        break;
      case 'quota':
        // the provider rarely says when quota comes back; check again in an hour unless told otherwise
        this.setHealth(account.id, { state: 'exhausted', until: now + (e.retryAfterMs ?? 3600_000), reason: e.message.slice(0, 160), measured: prev?.measured });
        break;
      case 'auth':
        this.setHealth(account.id, { state: 'auth_error', reason: e.message.slice(0, 160) });
        break;
      case 'network':
        this.setHealth(account.id, { state: 'offline', until: now + (account.local ? 30_000 : 60_000), reason: e.message.slice(0, 160) });
        break;
      case 'server':
        this.setHealth(account.id, { state: 'cooling', until: now + 30_000, reason: 'provider error', measured: prev?.measured });
        break;
      default:
        break;
    }
  }
}

function buildPrompt(task: TaskSpec, account: Account, cwd: string | undefined): string {
  const parts: string[] = [`# Task: ${task.title}`, '', task.prompt.trim()];
  if (task.acceptance) parts.push('', '## Done means', task.acceptance.trim());
  if (task.files?.length) {
    if (account.driver === 'cli' && cwd) {
      parts.push('', '## Files to look at', ...task.files.map((f) => `- ${f}`));
    } else {
      let budget = MAX_FILE_BYTES;
      parts.push('', '## Files');
      for (const f of task.files) {
        const full = cwd && !path.isAbsolute(f) ? path.join(cwd, f) : f;
        let body: string;
        try {
          body = fs.readFileSync(full, 'utf8');
        } catch {
          parts.push(`### ${f}`, '(could not read this file)');
          continue;
        }
        if (body.length > budget) body = body.slice(0, Math.max(0, budget)) + '\n[...cut: file too long...]';
        budget -= body.length;
        parts.push(`### ${f}`, '```', body, '```');
        if (budget <= 0) break;
      }
    }
  }
  if (effectivePrivacy(task) !== 'public') parts.push('', 'Treat everything above as confidential.');
  return parts.join('\n');
}
