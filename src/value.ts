// How much work other accounts did instead of Claude: the jobs they answered, how many Claude accepted,
// and the tokens they processed. It is counted, not estimated, so no price is put on it: a Claude
// subscription is not billed per token, and a figure in dollars would be a guess presented as a fact.
import type { UsageRecord } from './types.js';
import { formatTokens } from './usage.js';

/** One line on the work other accounts did instead of Claude, such as "last 7 days: other accounts answered 29 jobs ...". */
export function describeDelegated(d: { days: number; jobs: number; accepted: number; rejected: number; tokens: number }): string {
  const rated = d.accepted || d.rejected ? ` (${d.accepted} accepted, ${d.rejected} rejected by Claude)` : '';
  return `last ${d.days} days: other accounts answered ${d.jobs} job${d.jobs === 1 ? '' : 's'}${rated} and processed ${formatTokens(d.tokens)} tokens that Claude did not have to`;
}

export interface Delegated {
  /** jobs that another account answered in the period */
  jobs: number;
  /** of those, the ones Claude accepted or rejected with rate_result */
  accepted: number;
  rejected: number;
  /** input and output tokens of the answered requests */
  tokens: number;
}

/**
 * Counts answered requests that belong to a job, since `since`. A failed request did no work, and a request
 * without a job, such as `omnitrix test`, was not delegated by Claude, so neither counts.
 */
export function delegated(records: UsageRecord[], verdicts: Map<string, 'accepted' | 'rejected'>, since: number): Delegated {
  const jobs = new Set<string>();
  let tokens = 0;
  for (const r of records) {
    if (!r.ok || !r.jobId || r.ts < since) continue;
    jobs.add(r.jobId);
    tokens += r.inputTokens + r.outputTokens;
  }
  let accepted = 0;
  let rejected = 0;
  for (const id of jobs) {
    const v = verdicts.get(id);
    if (v === 'accepted') accepted++;
    else if (v === 'rejected') rejected++;
  }
  return { jobs: jobs.size, accepted, rejected, tokens };
}
