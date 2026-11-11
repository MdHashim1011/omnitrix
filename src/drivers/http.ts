// Shared pieces for the API drivers: requests with a timeout, and turning provider errors and
// rate-limit headers into something the router can act on.
import { redact } from '../store.js';
import { DriverError, type ErrorKind } from '../types.js';

export function classifyStatus(status: number, body: string): ErrorKind {
  const text = body.toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) {
    // "limit: 0" means the plan includes no allowance for this model at all (Gemini's free tier and Pro
    // models, for example). That is the model's problem, not a sign that the whole account is used up.
    if (/limit: 0\b/.test(text)) return 'model_gone';
    // some providers use 429 for "you are out of credits" as well as "slow down"
    return /(quota|insufficient|exceeded your current|billing|credit|balance)/.test(text) ? 'quota' : 'rate_limit';
  }
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  // Providers retire models but keep listing them; this is the model's fault, not the task's.
  if ((status === 404 || status === 400) && /model/.test(text) && /(no longer available|not found|does not exist|is not supported|deprecated|retired)/.test(text)) return 'model_gone';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/** Parse Retry-After (seconds or HTTP date) and the common reset headers. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset');
  if (reset) return parseDuration(reset, now);
  return undefined;
}

/** "1m30s", "12.5s", "250ms", a unix timestamp, or plain seconds. */
export function parseDuration(value: string, now = Date.now()): number | undefined {
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 1e12) return Math.max(0, n - now); // ms timestamp
    if (n > 1e9) return Math.max(0, n * 1000 - now); // s timestamp
    return n * 1000;
  }
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  if (matched) return total;
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function readRateHeaders(headers: Headers, now = Date.now()) {
  const num = (name: string) => {
    const v = headers.get(name);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const remainingRequests = num('x-ratelimit-remaining-requests') ?? num('anthropic-ratelimit-requests-remaining') ?? num('x-ratelimit-remaining');
  const remainingTokens = num('x-ratelimit-remaining-tokens') ?? num('anthropic-ratelimit-tokens-remaining');
  if (remainingRequests === undefined && remainingTokens === undefined) return undefined;
  let resetAt: number | undefined;
  const reset = headers.get('x-ratelimit-reset-requests') ?? headers.get('anthropic-ratelimit-requests-reset');
  if (reset) {
    const ms = parseDuration(reset, now);
    if (ms !== undefined) resetAt = now + ms;
  }
  return { remainingRequests, remainingTokens, resetAt };
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, signal?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(new Error('cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const kind = classifyStatus(res.status, text);
      throw new DriverError(`HTTP ${res.status}: ${redact(text.slice(0, 400))}`, kind, res.status, retryAfterMs(res.headers));
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new DriverError(`provider returned invalid JSON: ${redact(text.slice(0, 200))}`, 'server', res.status);
    }
    return { json, headers: res.headers };
  } catch (err) {
    if (err instanceof DriverError) throw err;
    if (signal?.aborted) throw new DriverError('cancelled', 'cancelled');
    if (ctrl.signal.aborted) throw new DriverError(`no answer after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
    const msg = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    throw new DriverError(`cannot reach ${new URL(url).host}: ${redact(msg)}`, 'network');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function getJson(url: string, headers: Record<string, string>, timeoutMs = 15_000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new DriverError(`HTTP ${res.status}: ${redact(text.slice(0, 300))}`, classifyStatus(res.status, text), res.status);
  return JSON.parse(text);
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
