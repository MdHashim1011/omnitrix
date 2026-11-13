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
  models: ModelInfo[];
  limits: Limits;
  /** max jobs at the same time on this account */
  concurrency: number;
  enabled: boolean;
  /** this provider may train on prompts (common on free tiers) */
  trainsOnData: boolean;
  local: boolean;
  /** lower number = preferred when scores tie */
  priority: number;
  addedAt: string;
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
  costUsd?: number;
}

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export type ErrorKind = 'rate_limit' | 'quota' | 'auth' | 'bad_request' | 'server' | 'network' | 'timeout' | 'cancelled' | 'model_gone' | 'unknown';

export interface TaskSpec {
  title: string;
  type: TaskType;
  prompt: string;
  privacy?: Privacy;
  /** files whose contents are added to the prompt (for HTTP models) */
  files?: string[];
  /** git repo to work in (for 'code' tasks); a separate worktree is created */
  repo?: string;
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
  /** only models without tools (API drivers); set on checks, whose prompt holds another worker's output */
  textOnly?: boolean;
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
  outputFile?: string;
  outputChars?: number;
  preview?: string;
  error?: string;
  worktree?: { path: string; branch: string; diffStat?: string };
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  verdict?: 'accepted' | 'rejected';
  /** why Claude accepted or rejected the result, as it said in rate_result */
  verdictNote?: string;
  /** the rejected job this one retries */
  retryOf?: string;
  check?: JobCheck;
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
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
