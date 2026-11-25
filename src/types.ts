import type { LockDiff } from './lockfile.js';

export type DriverKind = 'openai' | 'anthropic' | 'cli';

/** What a piece of work is about. The router uses this to pick a model. */
export const TASK_TYPES = [
  'code',        // edit files in a repo (needs an agent CLI: codex, claude, qwen...)
  'code_snippet',// write code as text, no repo access
  'review',      // check someone else's work
  'reasoning',   // hard thinking, planning, math, debugging logic
  'long_context',// read a lot of input and answer about it
  'bulk',        // cheap work: summarize, translate, extract, format
  'writing',     // docs, prose, messages
  'vision',      // the input includes images
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * public  - any provider is fine
 * private - only providers that do not train on your data
 * secret  - only models running on this machine
 */
export type Privacy = 'public' | 'private' | 'secret';

export interface Skills {
  coding: number;
  reasoning: number;
  writing: number;
  longContext: number;
  vision: number;
  speed: number;
}

export interface ModelInfo {
  id: string;
  skills: Skills;
  /** USD per million tokens, if known. 0 for local or included in a plan. */
  inputPrice?: number;
  outputPrice?: number;
  /** true when the user set the scores by hand */
  pinned?: boolean;
  /** where the scores come from: no information, a guess from the name or the server's report, or set by hand */
  basis?: 'untested' | 'estimated' | 'manual';
  /** true when the server itself reported whether the model reads images */
  visionChecked?: boolean;
  /** false when the server reported that the model cannot call tools, so it cannot work as an agent */
  tools?: boolean;
  /** the exact version the server reported (Ollama), so feedback on an old version is not carried over */
  digest?: string;
}

export interface Limits {
  requestsPerMinute?: number;
  requestsPer5h?: number;
  requestsPerDay?: number;
  requestsPerWeek?: number;
  tokensPerDay?: number;
  tokensPerMonth?: number;
}

export interface Account {
  id: string;
  label: string;
  /** who owns this account, e.g. "me" or a friend's name */
  owner: string;
  provider: string;
  driver: DriverKind;
  baseUrl?: string;
  /** "env:NAME" reads the key from an environment variable, "secret" reads it from the secrets file */
  apiKey?: string;
  /** isolated config folder for CLI accounts */
  profileDir?: string;
  /** how hard this account's reasoning models think when a task does not say; the model's own default otherwise */
  effort?: Effort;
  models: ModelInfo[];
  limits: Limits;
  /** max jobs at the same time on this account */
  concurrency: number;
  enabled: boolean;
  /** this provider may train on prompts (common on free tiers) */
  trainsOnData: boolean;
  /** keep only the provider's free models; OpenRouter marks them with a ":free" ending */
  freeOnly?: boolean;
  local: boolean;
  /** lower number = preferred when scores tie */
  priority: number;
  addedAt: string;
  /** comes from the team file the developer joined; rebuilt on every load and never saved locally */
  team?: boolean;
}

/**
 * A named way to route a task. It only steers omnitrix's own router: quota, privacy, health and past verdicts
 * still apply to every task that uses it.
 */
export interface JobStructured {
  status: 'valid' | 'invalid' | 'not_json';
  /** what is wrong, as "path: problem", at most 10 */
  errors?: string[];
}

export interface RouteDef {
  description: string;
  /** only these accounts ("accountId") or models ("accountId/modelId") */
  use?: string[];
  /** how to rank: quality ranks by strength alone, saver puts cost first */
  mode?: 'balanced' | 'quality' | 'saver';
  /** prefer models that answered quickly before */
  fast?: boolean;
  /** only models on this computer */
  local?: boolean;
}

export interface Settings {
  /** never send private/secret work to providers that train on data */
  protectPrivate: boolean;
  /** how many characters of a result Claude sees by default */
  resultPreviewChars: number;
  /** jobs time out after this many seconds */
  jobTimeoutSec: number;
  /** "quality" prefers the best model, "saver" prefers cheap/free */
  mode: 'balanced' | 'quality' | 'saver';
  bannedProviders: string[];
  /** task type -> list of "accountId/modelId" to always try first */
  pins: Partial<Record<TaskType, string[]>>;
  /** routes of the user's own, by name; a name of a built-in route replaces it */
  routes?: Record<string, RouteDef>;
  /** "off" keeps code tasks away from API accounts; otherwise they run through OpenCode when it is installed */
  apiCodeAgent?: 'opencode' | 'off';
  /**
   * whether the first dispatch of a Claude session shows the dashboard; on unless set to off. "on" uses
   * Claude's browser pane inside the Claude desktop app and the default browser elsewhere; "browser" always
   * uses the default browser.
   */
  openDashboard?: 'on' | 'off' | 'browser';
  /** whether omnitrix picks the reasoning effort of a Codex task from its type when nobody chose one; on unless set to off */
  autoEffort?: 'on' | 'off';
  /** "all" keeps every Codex tool, such as browser and computer use; otherwise those a worker never needs are left out */
  codexTools?: 'lean' | 'all';
  /** the team file this developer joined, if any */
  team?: { file: string; user: string; sha256: string };
}

export interface Config {
  version: 1;
  accounts: Account[];
  settings: Settings;
}

export type HealthState = 'ready' | 'busy' | 'cooling' | 'exhausted' | 'auth_error' | 'disabled' | 'offline';

export interface AccountHealth {
  state: HealthState;
  until?: number;
  reason?: string;
  /** latest rate-limit numbers the provider told us */
  measured?: { remainingRequests?: number; remainingTokens?: number; resetAt?: number; at: number; source: string };
  /** how many prompt tokens this model really reads, learned when it cut a longer prompt (key from contextLimitKey) */
  contextTokens?: number;
  /** the model's token limit for a minute, learned when a request was bigger than all of it (key from minuteLimitKey) */
  minuteTokens?: number;
  /** whether that limit counts only the answer, not the prompt */
  minuteOutputOnly?: boolean;
  /** when this entry was written */
  at?: number;
}

export interface UsageRecord {
  ts: number;
  accountId: string;
  model: string;
  jobId?: string;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
  status?: number;
  errorKind?: ErrorKind;
  latencyMs: number;
  /** reported by the provider, or estimated from the model's price */
  costUsd?: number;
  /** who sent it, and for which team, when the request used a team account */
  user?: string;
  team?: string;
}

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export type ErrorKind = 'rate_limit' | 'quota' | 'model_quota' | 'paid_model' | 'auth' | 'bad_request' | 'server' | 'network' | 'timeout' | 'cancelled' | 'model_gone' | 'too_long' | 'unknown';

export interface TaskSpec {
  title: string;
  type: TaskType;
  prompt: string;
  privacy?: Privacy;
  /** files whose contents are added to the prompt (for HTTP models) */
  files?: string[];
  /** git repo to work in (for 'code' tasks); a separate worktree is created */
  repo?: string;
  /** for code tasks: a test command (program and arguments) that omnitrix runs in the job's worktree afterwards */
  test?: string[];
  /** what "done" means; added to the prompt and used by the reviewer */
  acceptance?: string;
  /** force a model: "accountId" or "accountId/modelId" */
  use?: string;
  /** small, medium or large; used to estimate tokens */
  size?: 'small' | 'medium' | 'large';
  effort?: Effort;
  /** accounts ("accountId") or models ("accountId/modelId") not to use, such as ones whose result was rejected */
  avoid?: string[];
  /** when the job is done, a different account checks the result against `acceptance` */
  check?: boolean;
  /** 2 to 5: send the task to that many different models, for independent answers to compare (not for code) */
  copies?: number;
  /** a finished job to continue: the same model gets that task, its own answer and this prompt (not for code) */
  followUpOf?: string;
  /** prefer models that answered quickly before, for tasks where waiting matters more than depth */
  fast?: boolean;
  /** a named route: fast, deep, cheap, local, or one the user defined in settings.routes */
  route?: string;
  /** try the cheap route first; when the check fails, or the test of a code task fails, run the task once more on the deep route */
  escalate?: boolean;
  /** a JSON Schema the answer must match; the worker is asked for that JSON only, and omnitrix checks it */
  outputSchema?: Record<string, unknown>;
  /** only models without tools (API drivers); set on checks, whose prompt holds another worker's output */
  textOnly?: boolean;
  /** models whose fit for this task type is lower are not used; set on checks, so a checker is not much weaker than the worker */
  minFit?: number;
}

export interface JobCheck {
  status: 'pending' | 'pass' | 'fail' | 'unclear' | 'unavailable';
  /** the job that does the checking */
  jobId?: string;
  /** "accountId/modelId" of the checker */
  by?: string;
  /** the checker's one-sentence reason, or why no check could run */
  note?: string;
}

/** What omnitrix itself found in a finished code job, for Claude's review. */
export interface JobVerify {
  /** files the worker changed, relative to the repository */
  files: string[];
  /** the branch's commit that these findings and the test are about; unset on jobs from before 0.8.6 */
  commit?: string;
  /** changed files that the task did not name; unset when the task named no files */
  outside?: string[];
  /** for each changed lockfile, which packages the job added, changed or removed */
  lockfiles?: LockDiff[];
  test?: {
    command: string;
    status: 'running' | 'passed' | 'failed' | 'error' | 'interrupted';
    exitCode?: number;
    /** the end of what the test printed, with keys hidden */
    output?: string;
    durationMs?: number;
  };
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Attempt {
  accountId: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  error?: string;
  errorKind?: ErrorKind;
}

export interface Job {
  id: string;
  task: TaskSpec;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  attempts: Attempt[];
  /** process that runs this job */
  pid?: number;
  /** owner token of the process that runs the job (see owner.ts) */
  owner?: string;
  accountId?: string;
  model?: string;
  /** the model with its version, under which Claude's verdict on this job is counted */
  modelKey?: string;
  /** omnitrix's own check of a code job */
  verify?: JobVerify;
  outputFile?: string;
  outputChars?: number;
  preview?: string;
  error?: string;
  /** while queued: every account that can take the job is resting, and it is tried again at this time */
  waitingUntil?: number;
  /** gitDir is the checkout's git folder, recorded before the worker ran */
  worktree?: { path: string; branch: string; diffStat?: string; gitDir?: string };
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  verdict?: 'accepted' | 'rejected';
  /** why Claude accepted or rejected the result, as it said in rate_result */
  verdictNote?: string;
  /** the rejected job this one retries */
  retryOf?: string;
  /** the job that retried this one, after Claude rejected it */
  retriedAs?: string;
  /** the cheap attempt whose failed check or test sent this task to a stronger model */
  escalatedFrom?: string;
  /** the stronger attempt that omnitrix started after this job's check or test failed */
  escalatedTo?: string;
  /** removed from the dashboard's job list by the user; the record and output stay */
  hidden?: boolean;
  /** the reasoning effort that the last attempt asked for, from the task, the account or omnitrix */
  effort?: Effort;
  /** omnitrix chose that effort from the kind of task, because neither the task nor the account set one */
  effortAuto?: boolean;
  /** whether the answer matched the task's outputSchema */
  structured?: JobStructured;
  check?: JobCheck;
  /** when omnitrix last moved the branch onto a newer HEAD, and which commit that was */
  rebased?: { at: number; onto: string };
  /** the job whose result this job checks */
  checkOf?: string;
}

export interface DriverRequest {
  account: Account;
  model: string;
  system?: string;
  prompt: string;
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** how hard a reasoning model should think; unset leaves the provider's default */
  effort?: Effort;
  /** leave out Codex's tools that a worker never needs; see settings.codexTools */
  lean?: boolean;
  /** pictures sent with the prompt, for drivers that can send them */
  images?: { mime: string; data: string }[];
}

export interface DriverResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  rate?: { remainingRequests?: number; remainingTokens?: number; resetAt?: number };
}

export class DriverError extends Error {
  constructor(
    message: string,
    public kind: ErrorKind,
    public status?: number,
    public retryAfterMs?: number,
    /** for too_long: how many prompt tokens the model reported reading */
    public readTokens?: number,
    /** for too_long: the model's token limit for a minute, when one request is bigger than all of it */
    public minuteLimit?: { tokens: number; outputOnly: boolean },
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
