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
    if (/limit: 0(?![\d.])/.test(text)) return 'model_gone';
    // some providers use 429 for "you are out of credits" as well as "slow down"
    return /(quota|insufficient|exceeded your current|billing|credit|balance)/.test(text) ? 'quota' : 'rate_limit';
  }
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  // Providers retire models but keep listing them; this is the model's fault, not the task's. The text must
  // name the model itself: "parameter X is not supported with this model" is about the request instead.
  if ((status === 404 || status === 400) && retiredModel(text)) return 'model_gone';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

function retiredModel(text: string): boolean {
  if (/(parameter|\bparam\b|argument|max_tokens|max_completion_tokens|reasoning_effort|temperature)/.test(text)) return false;
  const names = /(model_not_found|invalid_model|models\/|the model|model `|model ')/.test(text);
  return names && /(no longer available|not found|does not exist|is not supported|deprecated|retired)/.test(text);
}

// Largest answers read from a provider; anything bigger is a broken or hostile server.
const MAX_ANSWER = 32 * 1024 * 1024;
const MAX_LIST = 4 * 1024 * 1024;

/** Read a response body, stopping once it passes `limit` bytes. */
export async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new DriverError(`the answer is too large (over ${Math.round(limit / 1024 / 1024)} MB)`, 'server', res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A provider asking for a longer wait than this is wrong or hostile; the account is looked at again after a day.
const MAX_WAIT = 24 * 3600_000;

/** Parse Retry-After (seconds or HTTP date) and the common reset headers, at most a day. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = waitFromHeaders(headers, now);
  return ms === undefined ? undefined : Math.min(ms, MAX_WAIT);
}

function waitFromHeaders(headers: Headers, now: number): number | undefined {
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
      // a redirect would carry the key and the prompt to another server
      redirect: 'error',
    });
    const text = await readCapped(res, MAX_ANSWER);
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
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const text = await readCapped(res, MAX_LIST);
  if (!res.ok) throw new DriverError(`HTTP ${res.status}: ${redact(text.slice(0, 300))}`, classifyStatus(res.status, text), res.status);
  return JSON.parse(text);
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
