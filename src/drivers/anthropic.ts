import { resolveKey } from '../store.js';
import { DriverError, type Account, type DriverRequest, type DriverResult } from '../types.js';
import { getJson, joinUrl, postJson, readRateHeaders } from './http.js';

function headers(account: Account): Record<string, string> {
  const key = resolveKey(account);
  if (!key) throw new DriverError(`no API key for ${account.id} (${account.apiKey ?? 'not set'})`, 'auth');
  return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
}

/** The Anthropic Messages format. Also spoken by DeepSeek, Kimi, GLM and MiniMax at their /anthropic URLs. */
export async function runAnthropic(req: DriverRequest): Promise<DriverResult> {
  const { account } = req;
  if (!account.baseUrl) throw new DriverError(`account ${account.id} has no base URL`, 'bad_request');
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? 8192,
    messages: [{ role: 'user', content: req.prompt }],
  };
  if (req.system) body.system = req.system;

  const { json, headers: h } = await postJson(joinUrl(account.baseUrl, 'v1/messages'), headers(account), body, req.timeoutMs, req.signal);
  const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  if (!blocks.length) throw new DriverError(`unexpected response: ${JSON.stringify(json).slice(0, 200)}`, 'server');
  const usage = json?.usage ?? {};
  return {
    text,
    inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    rate: readRateHeaders(h),
  };
}

export async function listAnthropicModels(account: Account): Promise<string[]> {
  if (!account.baseUrl) return [];
  const json = await getJson(joinUrl(account.baseUrl, 'v1/models'), headers(account));
  const list: any[] = Array.isArray(json?.data) ? json.data : [];
  return list.map((m) => String(m.id ?? '')).filter(Boolean);
}
