import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { Engine, type PoolAccountView } from './engine.js';
import { TASK_TYPES, type Job, type TaskSpec } from './types.js';
import { formatTokens } from './usage.js';
import { VERSION } from './version.js';

export const INSTRUCTIONS = `omnitrix gives you a team of other AI models (ChatGPT/Codex, DeepSeek, Kimi, GLM, Qwen, Groq, OpenRouter, local Ollama models and more) that run on the user's own accounts. You are the lead: you plan, they do the heavy work, you check it.

How to work:
1. Call pool_status to see which accounts are ready and how much quota is left.
2. Split the job into small, independent tasks. Give each one a clear title, a type (code, code_snippet, review, reasoning, long_context, bulk, writing, vision), a precise prompt and an "acceptance" line that says what done means. Tasks that edit files need type "code" and the repo path; each runs in its own git worktree and branch, so give parallel tasks separate files.
3. Call dispatch with all independent tasks at once. Use route_preview first if you want to see who would get them.
4. Call get_results to collect them. Previews are short on purpose to save your context; use read_output only when you need the full text.
5. Check each result against its acceptance line. Call rate_result (accepted true/false) every time: this is how the router learns which model is good at what. Re-dispatch rejected work with a sharper prompt, or do it yourself if it is small.
6. Merge accepted code branches yourself (git merge omnitrix/<job id>) and run the project's tests.

Do the planning, the tricky decisions and the final review yourself. Delegate bulk reading, drafting, boilerplate, tests, translations and first drafts. Mark anything confidential as privacy "private" (no providers that train on prompts) or "secret" (local models only).`;

const taskSchema = z.object({
  title: z.string().min(1).max(200).describe('short name for the task'),
  type: z.enum(TASK_TYPES).describe('what kind of work this is; decides which model is chosen'),
  prompt: z.string().min(1).describe('complete instructions for the worker; it sees nothing else'),
  acceptance: z.string().optional().describe('what a correct result must contain or pass'),
  privacy: z.enum(['public', 'private', 'secret']).optional().describe('private (default): no providers that train on data; secret: local models only'),
  files: z.array(z.string()).max(50).optional().describe('files whose content the worker needs (paths relative to repo, or absolute)'),
  repo: z.string().optional().describe('absolute path of a git repo; required for type "code"'),
  use: z.string().optional().describe('force an account ("accountId") or model ("accountId/modelId")'),
  size: z.enum(['small', 'medium', 'large']).optional(),
  critical: z.boolean().optional().describe('important result; review it extra carefully'),
});

function text(t: string, structured?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function fail(t: string) {
  return { content: [{ type: 'text' as const, text: t }], isError: true };
}

export function describeAccount(a: PoolAccountView): string {
  const u = a.usage;
  const bits = [`${a.id} [${a.state}]`, `${a.provider}`, `owner ${a.owner}`];
  if (u.windows.length) {
    bits.push(u.windows.map((w) => `${w.name}: ${w.remaining}/${w.limit} ${w.unit} left`).join(', ') + (u.source === 'measured' ? ' (measured)' : ' (estimated)'));
  } else {
    bits.push('no limits set');
  }
  if (u.measured?.remainingRequests !== undefined) bits.push(`provider says ${u.measured.remainingRequests} requests left`);
  bits.push(`today: ${u.requestsToday} req, ${formatTokens(u.tokensToday)} tokens${u.costToday ? `, $${u.costToday.toFixed(3)}` : ''}`);
  if (a.until) bits.push(`back at ${new Date(a.until).toLocaleTimeString()}`);
  if (a.reason) bits.push(a.reason);
  bits.push(`models: ${a.models.slice(0, 6).join(', ')}${a.models.length > 6 ? ` +${a.models.length - 6}` : ''}`);
  return '- ' + bits.join(' | ');
}

function jobView(j: Job, full: boolean, engine: Engine) {
  const out: Record<string, unknown> = {
    job_id: j.id,
    title: j.task.title,
    status: j.status,
    account: j.accountId,
    model: j.model,
  };
  if (j.status === 'done') {
    out.result = full ? (engine.readOutput(j.id) ?? j.preview) : j.preview;
    if (!full && (j.outputChars ?? 0) > (j.preview?.length ?? 0)) out.truncated = `${j.outputChars} chars in total; call read_output for the rest`;
    if (j.worktree) out.branch = j.worktree.branch;
    if (j.usage) out.tokens = j.usage.inputTokens + j.usage.outputTokens;
  }
  if (j.error && j.status !== 'done') out.error = j.error;
  if (j.attempts.length > 1) out.attempts = j.attempts.map((a) => `${a.accountId}/${a.model}: ${a.ok ? 'ok' : a.errorKind ?? 'failed'}`);
  return out;
}

export function buildServer(engine: Engine): McpServer {
  const server = new McpServer({ name: 'omnitrix', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'pool_status',
    {
      title: 'Pool status',
      description: 'List every connected AI account with its state, owner, models and how much quota is used and left.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const pool = engine.pool();
      if (!pool.length) return text('No accounts yet. The user can add some with: omnitrix add <provider> (run "omnitrix providers" for the list).');
      const ready = pool.filter((a) => a.state === 'ready' || a.state === 'busy').length;
      const lines = [`${ready}/${pool.length} accounts available`, ...pool.map(describeAccount)];
      return text(lines.join('\n'), { accounts: pool.map((a) => ({ id: a.id, state: a.state, provider: a.provider, owner: a.owner, percentUsed: a.usage.percentUsed ?? null, source: a.usage.source })) });
    },
  );

  server.registerTool(
    'route_preview',
    {
      title: 'Preview routing',
      description: 'Show which account and model would get each task, and why, without running anything.',
      inputSchema: z.object({ tasks: z.array(taskSchema).min(1).max(30) }),
      annotations: { readOnlyHint: true },
    },
    async ({ tasks }) => {
      const lines: string[] = [];
      for (const t of tasks as TaskSpec[]) {
        const { candidates, rejected } = engine.preview(t);
        lines.push(`## ${t.title} (${t.type})`);
        if (!candidates.length) lines.push('  nobody can take it: ' + rejected.slice(0, 6).map((r) => `${r.accountId}: ${r.reason}`).join('; '));
        candidates.slice(0, 3).forEach((c, i) => lines.push(`  ${i + 1}. ${c.accountId}/${c.model}  score ${c.score.toFixed(2)}  (${c.why.join(', ')})`));
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'dispatch',
    {
      title: 'Dispatch tasks',
      description: 'Send tasks to the worker pool. Independent tasks run in parallel on different accounts. Returns job ids right away; collect results with get_results.',
      inputSchema: z.object({ tasks: z.array(taskSchema).min(1).max(30) }),
    },
    async ({ tasks }) => {
      for (const t of tasks) {
        if (t.type === 'code' && !t.repo) return fail(`task "${t.title}": type "code" needs "repo" (absolute path of a git repository)`);
      }
      const jobs = engine.dispatch(tasks as TaskSpec[]);
      const lines = jobs.map((j) => `${j.id}  ${j.task.title}  -> ${j.status === 'failed' ? `FAILED: ${j.error}` : j.accountId ? `${j.accountId}/${j.model}` : 'queued'}`);
      return text(lines.join('\n') + '\n\nCall get_results with these job ids.', { job_ids: jobs.map((j) => j.id) });
    },
  );

  server.registerTool(
    'get_results',
    {
      title: 'Get results',
      description: 'Wait for jobs and return their status and a short preview of each result. Waits up to wait_seconds (default 45) for unfinished jobs.',
      inputSchema: z.object({
        job_ids: z.array(z.string()).min(1).max(50),
        wait_seconds: z.number().int().min(0).max(110).optional(),
        full: z.boolean().optional().describe('return complete outputs instead of previews (uses more context)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ job_ids, wait_seconds, full }) => {
      const jobs = await engine.wait(job_ids, wait_seconds ?? 45);
      const missing = job_ids.filter((id) => !jobs.some((j) => j.id === id));
      const views = jobs.map((j) => jobView(j, !!full, engine));
      const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
      const head = pending ? `${pending} still working; call get_results again for them.\n\n` : '';
      const miss = missing.length ? `\nunknown job ids: ${missing.join(', ')}` : '';
      return text(head + JSON.stringify(views, null, 2) + miss, { jobs: views });
    },
  );

  server.registerTool(
    'read_output',
    {
      title: 'Read full output',
      description: 'Read the full output of a finished job, in pages.',
      inputSchema: z.object({ job_id: z.string(), offset: z.number().int().min(0).optional(), length: z.number().int().min(100).max(40000).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ job_id, offset, length }) => {
      const out = engine.readOutput(job_id);
      if (out === undefined) return fail(`no output for job ${job_id}`);
      const start = offset ?? 0;
      const len = length ?? 12000;
      const part = out.slice(start, start + len);
      const rest = out.length - (start + part.length);
      return text(part + (rest > 0 ? `\n\n[${rest} more chars; next offset ${start + part.length}]` : ''));
    },
  );

  server.registerTool(
    'rate_result',
    {
      title: 'Rate a result',
      description: 'Tell omnitrix whether a finished job was good enough. The router uses this to choose better models next time.',
      inputSchema: z.object({ job_id: z.string(), accepted: z.boolean(), note: z.string().max(500).optional() }),
    },
    async ({ job_id, accepted }) => {
      const job = engine.verdict(job_id, accepted);
      if (!job) return fail(`job ${job_id} is not a finished job`);
      return text(`recorded: ${job.model} ${accepted ? 'accepted' : 'rejected'} for ${job.task.type}`);
    },
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel a job',
      description: 'Stop a queued or running job.',
      inputSchema: z.object({ job_id: z.string() }),
    },
    async ({ job_id }) => (engine.cancel(job_id) ? text(`cancelling ${job_id}`) : fail(`job ${job_id} is not running`)),
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Recent jobs with their status.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const jobs = engine.listJobs(limit ?? 20);
      if (!jobs.length) return text('no jobs yet');
      return text(jobs.map((j) => `${j.id}  ${j.status.padEnd(9)} ${j.accountId ?? '-'}/${j.model ?? '-'}  ${j.task.title}${j.verdict ? `  [${j.verdict}]` : ''}`).join('\n'));
    },
  );

  return server;
}

export function startMcp(): void {
  const engine = new Engine();
  serveStdio(() => buildServer(engine), { onerror: (err) => process.stderr.write(`omnitrix: ${err.message}\n`) });
}
