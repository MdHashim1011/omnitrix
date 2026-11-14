import type { DriverKind, Limits } from './types.js';

export interface ProviderSpec {
  id: string;
  name: string;
  driver: DriverKind;
  baseUrl?: string;
  /** environment variable people usually keep this key in */
  keyEnv?: string;
  /** a second endpoint that speaks the Anthropic Messages format */
  anthropicUrl?: string;
  local?: boolean;
  /** true if the free tier may use prompts for training */
  trainsOnData?: boolean;
  /** models to register when the provider has no /models endpoint we can use */
  models?: string[];
  limits?: Limits;
  /** CLI tool id from drivers/cli.ts */
  cli?: string;
  signup?: string;
  note?: string;
}

/**
 * Built-in providers. Anything that speaks the OpenAI or Anthropic format can also be added
 * with "custom-openai" / "custom-anthropic" and a base URL, so this list is a convenience, not a limit.
 */
export const PROVIDERS: ProviderSpec[] = [
  // Agent CLIs that sign in with a subscription. They run on this machine and can edit files.
  { id: 'codex', name: 'ChatGPT / Codex CLI', driver: 'cli', cli: 'codex', signup: 'https://chatgpt.com', note: 'Uses your ChatGPT plan through the official Codex CLI.' },
  { id: 'claude-code', name: 'Claude Code CLI', driver: 'cli', cli: 'claude', signup: 'https://claude.com', note: 'Only use your own subscription. Anthropic does not allow account sharing.' },
  { id: 'qwen-code', name: 'Qwen Code CLI', driver: 'cli', cli: 'qwen', signup: 'https://github.com/QwenLM/qwen-code' },
  { id: 'gemini-cli', name: 'Gemini CLI (API key)', driver: 'cli', cli: 'gemini', keyEnv: 'GEMINI_API_KEY', trainsOnData: true, signup: 'https://aistudio.google.com/apikey', note: 'Since June 2026 Gemini CLI needs an API key; consumer Google sign-in moved to Antigravity.' },
  { id: 'antigravity', name: 'Google Antigravity CLI (experimental)', driver: 'cli', cli: 'agy', signup: 'https://antigravity.google', note: 'Experimental. Google has suspended accounts used through outside tools; use at your own risk.' },
  { id: 'opencode', name: 'OpenCode CLI', driver: 'cli', cli: 'opencode', signup: 'https://opencode.ai' },

  // Hosted APIs (OpenAI-compatible).
  { id: 'openai', name: 'OpenAI API', driver: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', signup: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', driver: 'openai', baseUrl: 'https://api.deepseek.com', anthropicUrl: 'https://api.deepseek.com/anthropic', keyEnv: 'DEEPSEEK_API_KEY', models: ['deepseek-flash', 'deepseek-v4-pro'], signup: 'https://platform.deepseek.com' },
  { id: 'kimi', name: 'Moonshot Kimi', driver: 'openai', baseUrl: 'https://api.moonshot.ai/v1', anthropicUrl: 'https://api.moonshot.ai/anthropic', keyEnv: 'MOONSHOT_API_KEY', signup: 'https://platform.moonshot.ai', note: 'Keys are region bound. China accounts use api.moonshot.cn.' },
  { id: 'glm', name: 'Z.ai GLM', driver: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', anthropicUrl: 'https://api.z.ai/api/anthropic', keyEnv: 'ZAI_API_KEY', signup: 'https://z.ai', note: 'GLM Coding Plan keys are meant for coding tools; add them as claude-code with the Anthropic URL.' },
  { id: 'minimax', name: 'MiniMax', driver: 'openai', baseUrl: 'https://api.minimax.io/v1', anthropicUrl: 'https://api.minimax.io/anthropic', keyEnv: 'MINIMAX_API_KEY', signup: 'https://www.minimax.io' },
  { id: 'qwen', name: 'Alibaba Qwen (Model Studio)', driver: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY', signup: 'https://www.alibabacloud.com/product/modelstudio' },
  { id: 'xai', name: 'xAI Grok', driver: 'openai', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', signup: 'https://console.x.ai' },
  { id: 'mistral', name: 'Mistral', driver: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', trainsOnData: true, signup: 'https://console.mistral.ai' },
  { id: 'gemini', name: 'Google Gemini API', driver: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', trainsOnData: true, signup: 'https://aistudio.google.com/apikey', note: 'The free tier may use prompts to improve Google products outside the EEA/UK/CH.' },
  { id: 'groq', name: 'Groq', driver: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', limits: { requestsPerMinute: 30, requestsPerDay: 1000 }, signup: 'https://console.groq.com', note: 'Free limits are per organization, so extra keys in the same org add nothing.' },
  { id: 'openrouter', name: 'OpenRouter', driver: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', signup: 'https://openrouter.ai/keys', note: ':free models allow 20 requests/min and 50/day (1000/day after buying $10 of credits).' },
  { id: 'cerebras', name: 'Cerebras', driver: 'openai', baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY', signup: 'https://cloud.cerebras.ai' },
  { id: 'together', name: 'Together AI', driver: 'openai', baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY', signup: 'https://api.together.ai' },
  { id: 'fireworks', name: 'Fireworks AI', driver: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY', signup: 'https://fireworks.ai' },
  { id: 'nvidia', name: 'NVIDIA NIM', driver: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', keyEnv: 'NVIDIA_API_KEY', signup: 'https://build.nvidia.com', note: 'Free access is for prototyping.' },

  // Hosted APIs (Anthropic format).
  { id: 'anthropic', name: 'Anthropic API', driver: 'anthropic', baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', signup: 'https://console.anthropic.com' },

  // Models running on your own machine. Nothing leaves the computer.
  { id: 'ollama', name: 'Ollama (local)', driver: 'openai', baseUrl: 'http://localhost:11434/v1', local: true, signup: 'https://ollama.com' },
  { id: 'lmstudio', name: 'LM Studio (local)', driver: 'openai', baseUrl: 'http://localhost:1234/v1', local: true, signup: 'https://lmstudio.ai' },
  { id: 'llamacpp', name: 'llama.cpp server (local)', driver: 'openai', baseUrl: 'http://localhost:8080/v1', local: true },
  { id: 'vllm', name: 'vLLM (local)', driver: 'openai', baseUrl: 'http://localhost:8000/v1', local: true },

  // Anything else.
  { id: 'custom-openai', name: 'Any OpenAI-compatible API', driver: 'openai' },
  { id: 'custom-anthropic', name: 'Any Anthropic-compatible API', driver: 'anthropic' },
];

export function getProvider(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
