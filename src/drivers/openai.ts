import { resolveKey } from '../store.js';
import { DriverError, type Account, type DriverRequest, type DriverResult } from '../types.js';
import { getJson, joinUrl, missingKey, postJson, readRateHeaders } from './http.js';
import { loadedContext, modelMaxContext, ollamaRoom } from './ollama.js';

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

  // Ollama's OpenAI-style endpoint cuts a prompt to the model's working size without an error and takes no
  // size with the request; its own endpoint does. An answer of up to 4,096 tokens is planned for, since local
  // models seldom write more and memory use grows with the size.
  if (account.provider === 'ollama') {
    const need = promptTokens(req) + Math.min(req.maxOutputTokens ?? 4096, 4096);
    if (ollamaRoom(need) !== undefined) {
      const auth = authHeaders(account);
      const [max, loaded] = await Promise.all([modelMaxContext(account.baseUrl, req.model, auth, req.signal), loadedContext(account.baseUrl, req.model, auth)]);
      const room = ollamaRoom(need, max, loaded);
      if (room) return runOllamaChat(req, account.baseUrl, room);
    }
  }

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
  const read = Number(usage.prompt_tokens ?? usage.input_tokens);
  const sent = promptTokens(req);
  if (Number.isFinite(read) && read > 0 && promptCut(sent, read)) {
    const n = (x: number) => x.toLocaleString('en-US');
    const hint = account.provider === 'ollama' ? '. Ollama cuts prompts to its working size; start it with OLLAMA_CONTEXT_LENGTH set higher, such as 32768, to give its models more room' : '';
    // Ollama says how much room it gave the model, which is more than the part of a cut prompt it kept
    const room = account.provider === 'ollama' && account.baseUrl ? await loadedContext(account.baseUrl, req.model) : undefined;
    throw new DriverError(`the model read only ${n(read)} of about ${n(sent)} tokens of the prompt and cut the rest, so its answer was not used${hint}`, 'too_long', undefined, undefined, room && room > read ? room : read);
  }
  return {
    text,
    inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
    costUsd: typeof usage.cost === 'number' ? usage.cost : undefined, // OpenRouter reports this
    rate: readRateHeaders(headers),
  };
}

/** Ollama's own chat endpoint, which takes the working size `room` with the request. */
async function runOllamaChat(req: DriverRequest, baseUrl: string, room: number): Promise<DriverResult> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.prompt, ...(req.images?.length ? { images: req.images.map((i) => i.data) } : {}) });
  const sent = promptTokens(req);
  const n = (x: number) => x.toLocaleString('en-US');
  // Ollama keeps only part of a prompt longer than the room, and the part it keeps can look whole
  if (sent > room) throw new DriverError(`the prompt has about ${n(sent)} tokens and this model can hold ${n(room)} here, so it was not sent`, 'too_long', undefined, undefined, room);
  const options: Record<string, number> = { num_ctx: room };
  if (req.maxOutputTokens) options.num_predict = req.maxOutputTokens;
  const body: Record<string, unknown> = { model: req.model, messages, stream: false, options };
  // the same levels that Ollama's OpenAI-style endpoint takes as reasoning_effort
  if (req.effort) body.think = req.effort;
  const { json, headers } = await postJson(`${root}/api/chat`, authHeaders(req.account), body, req.timeoutMs, req.signal);
  const content = json?.message?.content;
  if (typeof content !== 'string') throw new DriverError(`unexpected response: ${JSON.stringify(json).slice(0, 200)}`, 'server');
  const read = Number(json?.prompt_eval_count);
  if (Number.isFinite(read) && read > 0 && promptCut(sent, read)) {
    // the size asked for did not hold, so what Ollama really loaded, or else what arrived, is the model's limit
    const loaded = await loadedContext(baseUrl, req.model, authHeaders(req.account));
    throw new DriverError(
      `the model read only ${n(read)} of about ${n(sent)} tokens of the prompt, although omnitrix asked Ollama for room for ${n(room)}, so its answer was not used. If this Ollama ignores the size asked for, start it with OLLAMA_CONTEXT_LENGTH set higher, such as 32768`,
      'too_long',
      undefined,
      undefined,
      loaded && loaded > read && loaded < room ? loaded : read,
    );
  }
  return { text: withoutThinking(content), inputTokens: Number.isFinite(read) ? read : 0, outputTokens: Number(json?.eval_count ?? 0), rate: readRateHeaders(headers) };
}

/** About how many tokens the text of a request takes: four characters each, pictures not counted. */
export function promptTokens(req: Pick<DriverRequest, 'system' | 'prompt'>): number {
  return Math.round(((req.system?.length ?? 0) + req.prompt.length) / 4);
}

/**
 * Whether a server read only part of a prompt. Local servers such as Ollama cut a prompt to their working
 * size without an error, and the model then answers what is left. Counting by characters is rough, so only a
 * long prompt of which less than half arrived counts.
 */
export function promptCut(sent: number, read: number): boolean {
  return sent > 3000 && read < sent / 2;
}

export async function listOpenAIModels(account: Account): Promise<string[]> {
  if (!account.baseUrl) return [];
  const json = await getJson(joinUrl(account.baseUrl, 'models'), authHeaders(account));
  const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return list.map((m) => String(m.id ?? m.name ?? '')).filter(Boolean);
}
