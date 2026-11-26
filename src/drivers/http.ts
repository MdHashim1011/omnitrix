// Shared pieces for the API drivers: requests with a timeout, and turning provider errors and
// rate-limit headers into something the router can act on.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { redact } from '../store.js';
import { DriverError, type Account, type ErrorKind } from '../types.js';

/**
 * Why an account has no key, in words that lead to the fix. A key variable set in a terminal is not seen by
 * omnitrix when Claude Code started it before the variable existed, which `omnitrix doctor` in that
 * terminal cannot show.
 */
export function missingKey(account: Account): string {
  if (account.apiKey?.startsWith('env:')) {
    const name = account.apiKey.slice(4);
    return `no API key for ${account.id}: ${name} is not set where omnitrix runs. If it is set in your terminal, restart Claude Code, which passes on only the variables that existed when it started`;
  }
  if (account.apiKey === 'secret') return `no API key for ${account.id}: no key is saved for it; save one with "omnitrix set ${account.id} --key-env NAME"`;
  return `no API key for ${account.id}: none is set; use "omnitrix set ${account.id} --key-env NAME"`;
}

const MINUTE = /per[ _]?min(ute)?(?![a-z])|perminute|per_minute|\b[rt]pm\b/;
const DAY = /per[ _]?day|perday|\b[rt]pd\b/;
// an allowance that names its model: Groq's "rate limit reached for model `m`", Gemini's "PerModel" quota ids,
// OpenAI's "rate limit reached for gpt-x in organization"
const MODEL_SCOPE = /(for model\b|per[ _]?model|"model"\s*:\s*"|rate limit reached for \S+ in organization)/;

export function classifyStatus(status: number, body: string): ErrorKind {
  const text = body.toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  // Gemini answers a wrong key with 400; the key is the problem, not the task
  if (status === 400 && /(api_key_invalid|api key not valid|invalid api key)/.test(text)) return 'auth';
  if (status === 402) {
    // OpenRouter's limit on spending in flight passes in a moment
    if (/in_flight_budget/.test(text)) return 'rate_limit';
    // Mistral's "You need a subscription to access this API" and SambaNova's "A payment method is required" are
    // about the whole account: none of its models work until the owner changes the plan
    if (/(need a subscription|payment method is required|add a payment method)/.test(text)) return 'quota';
    // Free keys at OpenRouter or Mistral answer 402 for the paid models only; the account's free models still
    // work. The engine pauses just that model, or the whole account when it has no other.
    return 'paid_model';
  }
  // One request bigger than the model's whole allowance for a minute (Groq on a free key), or too large for the
  // server at all: waiting never helps, a smaller request or another model does. A limit of 0 is handled below.
  if (status === 413 || (status === 429 && /request too large/.test(text) && !/limit:? 0(?![\d.])/.test(text))) return 'too_long';
  if (status === 429) {
    // "high demand" or "overloaded" is about one busy model, and so is a model that OpenRouter's upstream
    // provider is throttling; "at capacity" is left out, since providers also say it about the account's own limit
    if (/(high demand|overloaded|rate-limited upstream|upstream_provider_shared_pool)/.test(text)) return 'server';
    // Anthropic's spend cap holds the whole organization until the date it names
    if (/(enforced_spend_limit|reached your api usage limits)/.test(text)) return 'quota';
    // "limit: 0" means the plan includes no allowance for this model at all (Gemini's free tier and Pro
    // models, for example). That is the model's problem, not a sign that the whole account is used up.
    if (/limit: 0(?![\d.])/.test(text)) return 'model_gone';
    // OpenRouter's daily allowance of free requests is the key's, shared by all its free models
    if (/free-models-per-day/.test(text)) return 'quota';
    // OpenRouter's "Provider returned error" is the upstream provider of one model, not the key's own limit
    if (/provider returned error/.test(text)) return 'server';
    // A limit per minute passes in a minute, however the provider words it ("tokens per minute", "per min",
    // Gemini's "PerMinutePerProject", Google's "per_minute_per_project"), even with an upgrade offer beside it.
    // Alibaba's DashScope reports its limit per minute as "exceeded your current quota" with a link to "token-limit".
    if ((MINUTE.test(text) && !DAY.test(text)) || /error-code#token-limit/.test(text)) return 'rate_limit';
    // Links are left out: "upgrade at .../settings/billing" says nothing about whether credit is left
    const words = text.replace(/https?:\/\/[^\s"'<>)\]]+/g, ' ');
    // A used-up allowance that names its model is that model's alone
    if (MODEL_SCOPE.test(words) && /(quota|exhausted|exceeded|limit reached)/.test(words)) return 'model_quota';
    // An empty balance or plan is the account's
    if (/(exceeded your current quota|insufficient|credit|balance|billing|payment)/.test(words)) return 'quota';
    // Any other used-up allowance is taken as the model's, which Gemini's "resource has been exhausted" often
    // is: the account's other models still get their turn, and an account with only that model rests
    if (/(quota|exhausted)/.test(words)) return 'model_quota';
    return 'rate_limit';
  }
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  // Providers retire models but keep listing them; this is the model's fault, not the task's. The text must
  // name the model itself: "parameter X is not supported with this model" is about the request instead.
  if ((status === 404 || status === 400) && retiredModel(text)) return 'model_gone';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/**
 * The per-minute token limit in Groq's "Request too large for model `m` ... on tokens per minute (TPM): Limit
 * 6000, Requested 16400" (OpenAI writes "tokens per min"). An "output tokens per minute" limit counts only the
 * answer, the other one the prompt too. A limit in other units, such as the bytes of a request, is not one.
 */
export function minuteLimit(body: string): { tokens: number; outputOnly: boolean } | undefined {
  const text = body.toLowerCase();
  const on = /request too large.*?\bon ((input |output )?tokens per min(ute)?\b)[^:]*:\s*limit:?\s+(\d+)/.exec(text);
  if (!on || Number(on[4]) <= 0) return undefined;
  // a limit on the prompt alone leaves the answer free, which a limit on both covers safely
  return { tokens: Number(on[4]), outputOnly: on[2] === 'output ' };
}

/** Gemini gives its wait in the answer (`"retryDelay": "37s"`) rather than in a Retry-After header. */
export function retryDelayInBody(body: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.min(Number(m[1]) * 1000, MAX_WAIT) : undefined;
}

function retiredModel(text: string): boolean {
  if (/(parameter|\bparam\b|argument|max_tokens|max_completion_tokens|reasoning_effort|temperature)/.test(text)) return false;
  // NVIDIA lists models that a given key cannot call and answers them with "Function '<id>': Not found for account"
  if (/function '[^']*': not found for account/.test(text)) return true;
  const names = /(model_not_found|invalid_model|models\/|the model|model `|model ')/.test(text);
  return names && /(no longer available|not found|does not exist|is not supported|deprecated|retired)/.test(text);
}

// Largest answers read from a provider; anything bigger is a broken or hostile server.
const MAX_ANSWER = 32 * 1024 * 1024;
const MAX_LIST = 4 * 1024 * 1024;

interface Reply {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

/**
 * One POST through Node's own HTTP client. The built-in fetch gives up after 300 seconds without response
 * headers whatever the caller allows, and an API sends its headers only once the whole answer is ready, so a
 * slow model failed at five minutes as a network fault. Here only the caller's signal ends the request.
 */
function send(url: string, headers: Record<string, string>, body: string, limit: number, signal: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : undefined;
    if (!client) return reject(new Error(`unsupported address ${target.protocol}`));
    const sent = { ...headers, 'accept-encoding': 'gzip, deflate, br', 'content-length': String(Buffer.byteLength(body)) };
    const req = client.request(target, { method: 'POST', headers: sent, signal }, (res) => {
      const status = res.statusCode ?? 0;
      // a redirect would carry the key and the prompt to another server, so it is never followed or waited on
      if (status >= 300 && status < 400) {
        res.destroy();
        return reject(new DriverError(`the provider answered HTTP ${status} with a redirect, which omnitrix does not follow`, 'server', status));
      }
      const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
      const unpack = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : undefined;
      const stream = unpack ? res.pipe(unpack) : res;
      const chunks: Buffer[] = [];
      // counted after unpacking, so a small packed answer cannot grow past the limit
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          reject(new DriverError(`the answer is too large (over ${Math.round(limit / 1024 / 1024)} MB)`, 'server', status));
          unpack?.destroy();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      res.on('error', reject);
      res.on('close', () => {
        if (!res.complete) reject(new Error('the connection closed before the answer was complete'));
      });
      stream.on('end', () => {
        const h = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) h.append(name, v);
        resolve({ status, ok: status >= 200 && status < 300, headers: h, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    // a server that switches protocols never answers, and Node then closes the request without an error
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      reject(new DriverError(`the provider switched protocols (HTTP ${res.statusCode}) instead of answering`, 'server', res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

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

/**
 * What a provider said went wrong, on one line: the sentence from a JSON error such as Gemini's
 * [{"error":{"message":"..."}}], or else the body itself. Only for people and Claude to read; the kind
 * of error is decided from the whole body.
 */
export function errorMessage(text: string): string {
  try {
    let j = JSON.parse(text);
    if (Array.isArray(j)) j = j[0];
    const m = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : undefined) ?? j?.message ?? j?.detail;
    if (typeof m === 'string' && m.trim()) return m.replace(/\s+/g, ' ').trim();
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, ' ').trim();
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, signal?: AbortSignal) {
  // an abort listener added now would never fire for a job that was already cancelled
  if (signal?.aborted) throw new DriverError('cancelled', 'cancelled');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctrl.abort(new Error('cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await send(url, { 'content-type': 'application/json', ...headers }, JSON.stringify(body), MAX_ANSWER, ctrl.signal);
    const text = res.text;
    if (!res.ok) {
      const kind = classifyStatus(res.status, text);
      // When an answer names a limit per day beside one per minute, its short wait is for the minute; the day
      // limit may still hold, so the engine's own longer rest applies instead
      const both = kind === 'model_quota' && MINUTE.test(text.toLowerCase()) && DAY.test(text.toLowerCase());
      const wait = both ? undefined : retryAfterMs(res.headers) ?? retryDelayInBody(text);
      throw new DriverError(`HTTP ${res.status}: ${redact(errorMessage(text).slice(0, 400))}`, kind, res.status, wait, undefined, minuteLimit(text));
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
  if (!res.ok) throw new DriverError(`HTTP ${res.status}: ${redact(errorMessage(text).slice(0, 300))}`, classifyStatus(res.status, text), res.status);
  return JSON.parse(text);
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
