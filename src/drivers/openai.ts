import { resolveKey } from '../store.js';
import { DriverError, type Account, type DriverRequest, type DriverResult } from '../types.js';
import { getJson, joinUrl, missingKey, postJson, readRateHeaders } from './http.js';

function authHeaders(account: Account): Record<string, string> {
  const key = resolveKey(account);
  if (!key && !account.local) throw new DriverError(missingKey(account), 'auth');
  const h: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  if (account.provider === 'openrouter') {
    h['x-title'] = 'omnitrix';
  }
  return h;
}

/**
 * The answer without a thinking block that some models put before it, such as Gemma 4's
 * "<thought>...</thought>" or DeepSeek R1's "<think>...</think>". Only a closed block at the very start
 * goes; a block later on is part of the answer, and an answer that is only thinking is kept whole.
 */
export function withoutThinking(text: string): string {
  const m = /^\s*<(think|thought|thinking)>[\s\S]*?<\/\1>\s*/i.exec(text);
  return m && m[0].length < text.length ? text.slice(m[0].length) : text;
}

/** Chat Completions: the format almost every provider and local runtime speaks. */
export async function runOpenAI(req: DriverRequest): Promise<DriverResult> {
  const { account } = req;
  if (!account.baseUrl) throw new DriverError(`account ${account.id} has no base URL`, 'bad_request');
  const messages = [] as { role: string; content: unknown }[];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({
    role: 'user',
    content: req.images?.length
      ? [{ type: 'text', text: req.prompt }, ...req.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } }))]
      : req.prompt,
  });

  const body: Record<string, unknown> = { model: req.model, messages, stream: false };
  // OpenAI's reasoning models refuse max_tokens; most other compatible APIs know only max_tokens
  if (req.maxOutputTokens) body[account.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = req.maxOutputTokens;
  // OpenAI, Gemini and other compatible APIs read this; it is sent only when a task asks for it
  if (req.effort) body.reasoning_effort = req.effort;

  const { json, headers } = await postJson(joinUrl(account.baseUrl, 'chat/completions'), authHeaders(account), body, req.timeoutMs, req.signal);
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const text = withoutThinking(typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? '').join('') : '');
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
