// Runs jobs: picks an account for each task, starts it, and hands it to the next account when one fails.
// Job records are kept on disk so the dashboard and other omnitrix processes can see them.
import fs from 'node:fs';
import path from 'node:path';
import { runDriver } from './drivers/index.js';
import { beat, isMine, OWNER, ownerAlive, sweepOwners } from './owner.js';
import { loadQuotas, refreshQuotas } from './quota.js';
import { route, effectivePrivacy, modelHealthKey, type Candidate, type Rejected, type RouteContext } from './router.js';
import { freeSeat, takeSeat } from './seats.js';
import { loadStats, recordVerdict } from './stats.js';
import { dropModel, ensureHome, files, findAccount, loadConfig, loadHealth, processAlive, readJson, redact, saveHealth, writeJson } from './store.js';
import { DriverError, type Account, type AccountHealth, type Config, type Job, type TaskSpec, type UsageRecord } from './types.js';
import { compactLedger, LedgerTail, recordUsage, summarize, type UsageSummary } from './usage.js';
import { createWorktree, discardWorktree, finishWorktree, isGitRepo } from './worktree.js';

const MAX_ATTEMPTS = 3;
// A model the provider no longer serves (or gives this plan no allowance for) is dropped from the account,
// and rests (GONE_PAUSE_MS), so trying it did no work and is not repeated: it does not use up one of the
// MAX_ATTEMPTS. The cap bounds a job that meets many such models in a row.
const MAX_TRIES = 12;
// A model with no allowance stays unusable, but the config drop that removes it can be lost (no lock on
// config.json), so it also rests this long in health.json, which every process reads.
const GONE_PAUSE_MS = 24 * 60 * 60_000;
const MODEL_PAUSE_MS = 5 * 60_000;
const MODEL_FAULTS = new Set(['model_gone', 'server', 'timeout']);
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

export { processAlive };

/**
 * How long one request may take. An agent CLI works in many steps, so it gets the whole job limit. An API
 * call sends nothing until its answer is complete, so a model that has gone silent would otherwise hold
 * the job for the full limit; the cap grows with the answer size the task asks for.
 */
export function requestTimeoutMs(driver: string, size: TaskSpec['size'], jobTimeoutSec: number): number {
  const job = jobTimeoutSec * 1000;
  if (driver === 'cli') return job;
  const cap = size === 'small' ? 120_000 : size === 'large' ? 600_000 : 300_000;
  return Math.min(job, cap);
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
  /** models paused after a timeout or server error, until their break ends */
  pausedModels: string[];
  /** the provider may train on prompts, so only public tasks go here */
  trainsOnData: boolean;
}

export class Engine {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private running: Record<string, number> = {};
  private health: Record<string, AccountHealth>;
  private usageCache?: { at: number; byAccount: Map<string, UsageRecord[]> };
  private ledger = new LedgerTail();
  private listeners = new Set<() => void>();
  private unsaved = new Set<string>();

  constructor() {
    ensureHome();
    compactLedger();
    this.health = loadHealth();
    beat();
    sweepOwners();
    this.recoverJobs();
    setInterval(() => this.tick(), 1000).unref();
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
      // However old, a job whose owner is gone must end, or `omnitrix clean` never removes it or its worktree.
      // updatedAt is left alone so an old crashed job still counts as old for `clean`.
      if ((job.status === 'queued' || job.status === 'running') && !ownerAlive(job.owner, job.pid)) {
        job.status = 'failed';
        job.error = 'interrupted: the omnitrix server stopped before this job finished';
        this.saveJob(job);
      }
      if (job.updatedAt < cutoff) continue;
      this.jobs.set(job.id, job);
    }
  }

  config(): Config {
    return loadConfig();
  }

  /** Usage records of the last 32 days, grouped by account once so each summary only scans its own. */
  private records(): Map<string, UsageRecord[]> {
    const now = Date.now();
    if (!this.usageCache || now - this.usageCache.at > 2000) {
      const byAccount = new Map<string, UsageRecord[]>();
      for (const r of this.ledger.read(now - 32 * 24 * 3600_000)) {
        const list = byAccount.get(r.accountId);
        if (list) list.push(r);
        else byAccount.set(r.accountId, [r]);
      }
      this.usageCache = { at: now, byAccount };
    }
    return this.usageCache.byAccount;
  }

  private routeContext(cfg: Config): RouteContext {
    const records = this.records();
    // another process (a CLI "set" or "test", a second server) may have seen the account more recently
    for (const [id, h] of Object.entries(loadHealth())) {
      if ((h.at ?? 0) > (this.health[id]?.at ?? 0)) this.health[id] = h;
    }
    const quotas = loadQuotas();
    const usage: Record<string, UsageSummary> = {};
    for (const a of cfg.accounts) usage[a.id] = summarize(a, records.get(a.id) ?? [], this.health[a.id], Date.now(), quotas[a.id]);
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
      // every model paused means the account cannot take work either, so say so until the first one is back
      let pausedUntil: number | undefined;
      const ends = a.models.map((m) => this.health[modelHealthKey(a.id, m.id)]).map((mh) => (mh?.state === 'cooling' && (mh.until ?? 0) > now ? mh.until! : 0));
      const pausedModels = a.models.filter((_, i) => ends[i]! > 0).map((m) => m.id);
      if (state === 'ready' && a.models.length) {
        if (ends.every((t) => t > 0)) {
          state = 'cooling';
          pausedUntil = Math.min(...ends);
        }
      }
      return {
        id: a.id,
        label: a.label,
        owner: a.owner,
        provider: a.provider,
        driver: a.driver,
        enabled: a.enabled,
        state,
        until: pausedUntil ?? (h?.until && h.until > now ? h.until : undefined),
        reason: pausedUntil ? 'every model is paused after errors' : state === 'ready' || state === 'busy' ? undefined : h?.reason,
        running: this.running[a.id] ?? 0,
        models: a.models.map((m) => m.id),
        usage: ctx.usage[a.id]!,
        local: a.local,
        pausedModels,
        trainsOnData: a.trainsOnData,
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
      const job: Job = { id: newId('j'), task, status: 'queued', createdAt: now, updatedAt: now, attempts: [], pid: process.pid, owner: OWNER };
      this.jobs.set(job.id, job);
      this.saveJob(job);
      return job;
    });
    this.pump();
    void refreshQuotas(this.config().accounts);
    return created;
  }

  getJob(id: string): Job | undefined {
    const mine = this.jobs.get(id);
    if (mine && isMine(mine)) return mine;
    // Our copy of another process's job is a snapshot from startup; its file has the current state.
    return readJson<Job | null>(path.join(files.jobs(), `${id}.json`), null) ?? mine;
  }

  /** Newest first. Other processes' jobs come from disk, since our copies are startup snapshots and miss new ones. */
  listJobs(limit = 50): Job[] {
    const all = new Map<string, Job>();
    for (const j of this.jobs.values()) if (isMine(j)) all.set(j.id, j);
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(files.jobs()).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
    } catch {
      // no jobs folder yet
    }
    // Job ids begin with their creation time in base 36, so sorting the names finds the newest jobs
    // without opening or stat-ing every file.
    ids.sort().reverse();
    for (const id of ids.slice(0, limit)) {
      if (all.has(id)) continue;
      const job = readJson<Job | null>(path.join(files.jobs(), `${id}.json`), null);
      if (job) all.set(id, job);
    }
    return [...all.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
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
    const job = this.getJob(id);
    if (!job || job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return false;
    if (!isMine(job)) {
      if (ownerAlive(job.owner, job.pid)) {
        // The owner cannot be reached directly, so leave a note it looks for every second.
        try {
          fs.writeFileSync(this.cancelNote(id), '');
        } catch {
          return false;
        }
      } else {
        job.status = 'cancelled';
        job.error = 'cancelled';
        job.updatedAt = Date.now();
        this.saveJob(job);
        this.notify();
      }
      return true;
    }
    this.controllers.get(id)?.abort();
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      this.saveJob(job);
      this.notify();
    }
    return true;
  }

  verdict(id: string, accepted: boolean, note?: string): Job | undefined {
    const job = this.getJob(id);
    if (!job || !job.model || job.status !== 'done') return undefined;
    job.verdict = accepted ? 'accepted' : 'rejected';
    job.verdictNote = note;
    try {
      recordVerdict(job.model, job.task.type, accepted);
    } catch (err) {
      // the verdict is still saved on the job; only the router's tally misses this one
      process.stderr.write(`omnitrix: could not save routing stats: ${err instanceof Error ? err.message : err}\n`);
    }
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

  private cancelNote(id: string): string {
    return path.join(files.jobs(), `${id}.cancel`);
  }

  /** Every second: retry saves that failed, and act on cancel notes left by other processes. */
  private tick(): void {
    beat();
    // A server can run for weeks; finished jobs older than a day leave memory and are read from disk when needed.
    const dayAgo = Date.now() - 24 * 3600_000;
    for (const [id, job] of this.jobs) {
      if (job.updatedAt < dayAgo && job.status !== 'queued' && job.status !== 'running' && !this.unsaved.has(id)) this.jobs.delete(id);
    }
    for (const id of [...this.unsaved]) {
      const job = this.jobs.get(id);
      if (job) this.saveJob(job);
      else this.unsaved.delete(id);
    }
    for (const job of this.jobs.values()) {
      if (!isMine(job)) continue;
      const note = this.cancelNote(job.id);
      if (!fs.existsSync(note)) continue;
      // A note can arrive just as the job finishes; then there is nothing left to cancel.
      fs.rmSync(note, { force: true });
      if (job.status === 'queued' || job.status === 'running') this.cancel(job.id);
    }
    // A seat freed by another process sends us no signal, so queued jobs look again.
    if ([...this.jobs.values()].some((j) => j.status === 'queued' && isMine(j))) this.pump();
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }

  // A save that still fails after writeJson's retries must not crash the server or turn a finished job into
  // a failed one. The in-memory state stays correct, and tick() saves it again until it sticks.
  private saveJob(job: Job): void {
    try {
      writeJson(path.join(files.jobs(), `${job.id}.json`), job);
      this.unsaved.delete(job.id);
    } catch (err) {
      if (!this.unsaved.has(job.id)) process.stderr.write(`omnitrix: could not save job ${job.id}, will retry: ${err instanceof Error ? err.message : err}\n`);
      this.unsaved.add(job.id);
    }
  }

  private setHealth(accountId: string, h: AccountHealth): void {
    const stamped = { ...h, at: Date.now() };
    this.health[accountId] = stamped;
    try {
      saveHealth({ [accountId]: stamped });
    } catch (err) {
      process.stderr.write(`omnitrix: could not save account health: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  /** Start every queued job that has a free account. */
  private pump(): void {
    const cfg = this.config();
    // only start our own jobs; another live process is responsible for its queue
    const queued = [...this.jobs.values()].filter((j) => j.status === 'queued' && isMine(j)).sort((a, b) => a.createdAt - b.createdAt);
    // an account found full once in this pass stays full for the rest of it; no need to ask again per job
    const full = new Set<string>();
    // Built once per pass: the usage picture is the same for every queued job, and `running` and
    // `health` inside it are live references, so jobs started earlier in this pass are still seen.
    const ctx = queued.length ? this.routeContext(cfg) : undefined;
    for (const job of queued) {
      // A retired, overloaded or silent model is that model's problem, not the account's: the account may be
      // tried again with another model, and the failing model is paused so it is not picked twice.
      const tried = new Set(job.attempts.filter((a) => !MODEL_FAULTS.has(a.errorKind ?? 'unknown')).map((a) => a.accountId));
      const { candidates, rejected } = route(job.task, ctx!);
      // After a server error or a timeout, other accounts go first: when a whole provider is down, the
      // remaining attempts should not all be spent on that provider's other models.
      const faulted = new Set(job.attempts.filter((a) => a.errorKind === 'server' || a.errorKind === 'timeout').map((a) => a.accountId));
      const fresh = candidates.filter((c) => !tried.has(c.accountId)).sort((x, y) => Number(faulted.has(x.accountId)) - Number(faulted.has(y.accountId)));
      // The account's limit counts jobs from every omnitrix process, so a seat is needed as well as local room.
      let seat: string | undefined;
      const free = fresh.find((c) => {
        const acc = findAccount(cfg, c.accountId)!;
        if (full.has(acc.id) || (this.running[c.accountId] ?? 0) >= acc.concurrency) return false;
        seat = takeSeat(acc.id, acc.concurrency, job.id);
        if (seat === undefined) full.add(acc.id);
        return seat !== undefined;
      });
      if (free) {
        void this.start(job, free, cfg, seat);
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
      // otherwise every suitable account is busy: stay queued; tick() tries again every second
    }
  }

  private async start(job: Job, cand: Candidate, cfg: Config, seat?: string): Promise<void> {
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
          timeoutMs: requestTimeoutMs(account.driver, job.task.size, cfg.settings.jobTimeoutSec),
          signal: ctrl.signal,
          effort: job.task.effort,
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
      this.applyFailure(account, e, cand.model);
      if (e.kind === 'model_gone') {
        try {
          dropModel(account.id, cand.model);
        } catch {
          // the attempt is still retried; the model is dropped next time
        }
      }

      if (ctrl.signal.aborted || e.kind === 'cancelled') {
        job.status = 'cancelled';
        job.error = 'cancelled';
      } else if (job.attempts.filter((a) => a.errorKind !== 'model_gone').length < MAX_ATTEMPTS && job.attempts.length < MAX_TRIES && e.kind !== 'bad_request') {
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
      freeSeat(seat);
      this.controllers.delete(job.id);
      job.updatedAt = Date.now();
      this.saveJob(job);
      this.notify();
      this.pump();
    }
  }

  private applyFailure(account: Account, e: DriverError, model: string): void {
    const now = Date.now();
    const prev = this.health[account.id];
    if (e.kind === 'model_gone') {
      this.setHealth(modelHealthKey(account.id, model), { state: 'cooling', until: now + GONE_PAUSE_MS, reason: 'not available on this account' });
      return;
    }
    if (e.kind === 'server' || e.kind === 'timeout') {
      // pause just this model; the router skips it and the job moves on to the account's other models
      this.setHealth(modelHealthKey(account.id, model), { state: 'cooling', until: now + MODEL_PAUSE_MS, reason: e.kind === 'timeout' ? 'no answer' : 'provider error' });
      if (account.models.length > 1) return;
    }
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
