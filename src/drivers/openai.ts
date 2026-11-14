import { resolveKey } from '../store.js';
import { DriverError, type Account, type DriverRequest, type DriverResult } from '../types.js';
import { getJson, joinUrl, postJson, readRateHeaders } from './http.js';

function authHeaders(account: Account): Record<string, string> {
  const key = resolveKey(account);
  if (!key && !account.local) throw new DriverError(`no API key for ${account.id} (${account.apiKey?.startsWith('env:') ? `set ${account.apiKey.slice(4)}` : account.apiKey === 'secret' ? 'no saved key' : 'not set'})`, 'auth');
  const h: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  if (account.provider === 'openrouter') {
    h['x-title'] = 'omnitrix';
  }
  return h;
}

/** Chat Completions: the format almost every provider and local runtime speaks. */
export async function runOpenAI(req: DriverRequest): Promise<DriverResult> {
  const { account } = req;
  if (!account.baseUrl) throw new DriverError(`account ${account.id} has no base URL`, 'bad_request');
  const messages = [] as { role: string; content: string }[];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt });

  const body: Record<string, unknown> = { model: req.model, messages, stream: false };
  if (req.maxOutputTokens) body.max_tokens = req.maxOutputTokens;
  // OpenAI, Gemini and other compatible APIs read this; it is sent only when a task asks for it
  if (req.effort) body.reasoning_effort = req.effort;

  const { json, headers } = await postJson(joinUrl(account.baseUrl, 'chat/completions'), authHeaders(account), body, req.timeoutMs, req.signal);
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : '';
  if (!text && !choice) throw new DriverError(`unexpected response: ${JSON.stringify(json).slice(0, 200)}`, 'server');

  const usage = json?.usage ?? {};
  return {
    text,
    inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    costUsd: typeof usage.cost === 'number' ? usage.cost : undefined, // OpenRouter reports this
    rate: readRateHeaders(headers),
  };
}

export async function listOpenAIModels(account: Account): Promise<string[]> {
  if (!account.baseUrl) return [];
  const json = await getJson(joinUrl(account.baseUrl, 'models'), authHeaders(account));
  const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return list.map((m) => String(m.id ?? m.name ?? '')).filter(Boolean);
}
