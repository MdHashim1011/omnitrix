import type { ModelInfo, Skills } from './types.js';

/**
 * Starting scores (0-10) for a model. They are a first guess, never a measurement: users can set
 * scores by hand, and the router also follows Claude's verdicts on real results (see stats.ts).
 */
type Kind = 'size' | 'tier' | 'special' | 'vision' | 'long';
interface Rule {
  kind: Kind;
  match: RegExp;
  set: Partial<Skills>;
}

const SMALL: Partial<Skills> = { coding: 3, reasoning: 3, writing: 4, longContext: 3, speed: 9 };
const MEDIUM: Partial<Skills> = { coding: 5, reasoning: 5, writing: 6, longContext: 5, speed: 8 };
const LARGE: Partial<Skills> = { coding: 7, reasoning: 7, writing: 7, longContext: 6, speed: 6 };

const RULES: Rule[] = [
  // size / tier hints first, later rules override
  { kind: 'size', match: /\b(nano|tiny|0\.5b|1b|1\.5b|2b|3b|4b)\b/, set: SMALL },
  { kind: 'size', match: /\b(7b|8b|9b|12b|14b|mini|small|lite|haiku|luna)\b/, set: MEDIUM },
  { kind: 'tier', match: /\b(flash|turbo|instant|fast)\b/, set: { coding: 7, reasoning: 6, writing: 7, longContext: 7, speed: 9 } },
  { kind: 'size', match: /\b(32b|70b|72b|large|medium)\b/, set: LARGE },
  { kind: 'tier', match: /\b(pro|max|plus|ultra|opus|sonnet|sol|terra|astra|k2|k3|v4|glm-5|grok-4|m2|m3|qwen3)/, set: { coding: 8, reasoning: 8, writing: 8, longContext: 8, speed: 6 } },
  { kind: 'tier', match: /(opus|fable|astra|v4-pro|grok-4\.6|glm-5\.3|kimi-k3|qwen3\.8-max)/, set: { coding: 9, reasoning: 9, writing: 9, longContext: 9, speed: 5 } },
  // specialties
  { kind: 'special', match: /(coder|codestral|devstral|code|codex|grok-build)/, set: { coding: 9 } },
  { kind: 'special', match: /(reason|think|r1|o3|o4|qwq)/, set: { reasoning: 9, speed: 4 } },
  { kind: 'vision', match: /(vl|vision|llava|pixtral|-v\b|omni)/, set: { vision: 8 } },
  { kind: 'long', match: /(gemini|kimi|deepseek-v4|deepseek-flash|minimax|long)/, set: { longContext: 9 } },
];

const BASE: Skills = { coding: 6, reasoning: 6, writing: 6, longContext: 6, vision: 0, speed: 6 };

/** Where a model's scores come from. Only a person's own scores are more than a guess. */
export type Basis = 'untested' | 'estimated' | 'manual';

export interface RateOptions {
  /** a model on this computer: its name is whatever someone tagged it, so brand words mean nothing */
  local?: boolean;
  /** what the server says the model can do, such as Ollama's "vision" */
  capabilities?: string[];
  /** the size the server reports, such as "3.2B" */
  parameterSize?: string;
}

function sizeFromParameters(size: string | undefined): Partial<Skills> | undefined {
  const m = /^([\d.]+)\s*([bm])$/i.exec(size?.trim() ?? '');
  if (!m) return undefined;
  const billions = Number(m[1]) / (m[2]!.toLowerCase() === 'm' ? 1000 : 1);
  return billions < 5 ? SMALL : billions < 20 ? MEDIUM : LARGE;
}

export function rateModel(modelId: string, opts: RateOptions = {}): { skills: Skills; basis: Basis } {
  const id = modelId.toLowerCase();
  const skills: Skills = { ...BASE };
  let matched = false;
  const reported = sizeFromParameters(opts.parameterSize);
  for (const rule of RULES) {
    if (!rule.match.test(id)) continue;
    if (opts.local) {
      // a local tag such as "defiant-fable" says nothing about quality, and only the server knows about vision
      if (rule.kind === 'tier' || rule.kind === 'long' || rule.kind === 'vision') continue;
      if (rule.kind === 'size' && reported) continue;
    }
    // a local "coder" or "r1" tag still hints at a specialty, but not at the very top of the scale
    const set = opts.local && rule.kind === 'special' ? Object.fromEntries(Object.entries(rule.set).map(([k, v]) => [k, k === 'speed' ? v : Math.min(v!, 8)])) : rule.set;
    Object.assign(skills, set);
    matched = true;
  }
  if (reported) {
    Object.assign(skills, reported, ...RULES.filter((r) => r.kind === 'special' && r.match.test(id)).map((r) => Object.fromEntries(Object.entries(r.set).map(([k, v]) => [k, k === 'speed' ? v : Math.min(v!, 8)]))));
    matched = true;
  }
  if (opts.capabilities) {
    skills.vision = opts.capabilities.includes('vision') ? 7 : 0;
    matched = true;
  } else if (!opts.local && skills.vision === 0 && /(gpt-|claude|gemini|grok|sonnet|opus|fable)/.test(id) && !/(gpt-oss|gpt-3\.5|code)/.test(id)) {
    // most hosted frontier models read images; GPT-OSS, GPT-3.5 and coding models are text only
    skills.vision = 6;
    matched = true;
  }
  return { skills, basis: matched ? 'estimated' : 'untested' };
}

/** Scores from the name alone, as before; kept for code that imports it. */
export function guessSkills(modelId: string): Skills {
  return rateModel(modelId).skills;
}

export function makeModel(id: string, extra: Partial<ModelInfo> = {}, opts: RateOptions = {}): ModelInfo {
  const { skills, basis } = rateModel(id, opts);
  return { id, skills, basis, ...(opts.capabilities ? { visionChecked: true } : {}), ...extra };
}

/** Where a saved model's scores come from; models saved before 0.1.19 carry no label. */
export function basisOf(m: ModelInfo): Basis {
  return m.pinned ? 'manual' : m.basis ?? 'estimated';
}

/** The key under which Claude's verdicts on a model are counted: with its version when the server names one. */
export function statsKey(m: Pick<ModelInfo, 'id' | 'digest'>): string {
  return m.digest ? `${m.id}@${m.digest.slice(0, 12)}` : m.id;
}

/** Skip models that are clearly not chat models (embeddings, audio, moderation...). */
export function isChatModel(id: string): boolean {
  if (/(embed|embedding|whisper|tts|audio|moderation|rerank|dall-e|image-gen|transcribe|guard)/i.test(id)) return false;
  // code-completion models (NVIDIA lists starcoder2) and reward models that only score answers do not chat
  if (/(starcoder|santacoder|codegen\b|-reward\b|\breward-)/i.test(id)) return false;
  // Gemini lists music (lyria), image output (-image, nano-banana), voice sessions (-live, realtime), research
  // and computer-use agents and attributed QA beside its chat models; none of them answer a chat request
  return !/(lyria|nano-banana|-image(-preview)?$|-live\b|realtime|deep-research|computer-use|\baqa$)/i.test(id);
}
