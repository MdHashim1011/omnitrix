// Providers change their APIs without notice. An account that answered before and now fails again and
// again with errors that are not limits, sign-in or network trouble is the usual sign of such a change.
import type { ErrorKind, UsageRecord } from './types.js';

/** Errors that a provider change can cause; limits, sign-in, network trouble and retired models have their own causes. */
const SUSPECT = new Set<ErrorKind>(['bad_request', 'server', 'unknown']);
/** Failures in a row, after the last success, before a change is suspected. */
const IN_A_ROW = 3;

/** One line for `omnitrix doctor`, or undefined when nothing points to a provider change. */
export function driftHint(accountId: string, records: UsageRecord[]): string | undefined {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  let lastOk = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.ok) {
      lastOk = i;
      break;
    }
  }
  if (lastOk < 0) return undefined;
  const after = sorted.slice(lastOk + 1);
  if (after.length < IN_A_ROW || !after.every((r) => r.errorKind && SUSPECT.has(r.errorKind))) return undefined;
  const kinds = [...new Set(after.map((r) => `${r.errorKind}${r.status ? ` ${r.status}` : ''}`))];
  const when = new Date(sorted[lastOk]!.ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return `${accountId} worked until ${when}, then its last ${after.length} requests failed (${kinds.join(', ')}). If "omnitrix test ${accountId}" fails the same way, the provider may have changed its API; please report it with that output.`;
}
