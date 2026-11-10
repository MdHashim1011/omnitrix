import type { ModelInfo, Skills } from './types.js';

/**
 * Starting scores (0-10) for a model, guessed from its name.
 * They are only a first guess: users can set scores by hand, and the router
 * adjusts its choices from real results (see stats.ts).
 */
interface Rule {
  match: RegExp;
  set: Partial<Skills>;
}

const RULES: Rule[] = [
  // size / tier hints first, later rules override
  { match: /\b(nano|tiny|0\.5b|1b|1\.5b|2b|3b|4b)\b/, set: { coding: 3, reasoning: 3, writing: 4, longContext: 3, speed: 9 } },
  { match: /\b(7b|8b|9b|12b|14b|mini|small|lite|haiku|luna)\b/, set: { coding: 5, reasoning: 5, writing: 6, longContext: 5, speed: 8 } },
  { match: /\b(flash|turbo|instant|fast)\b/, set: { coding: 7, reasoning: 6, writing: 7, longContext: 7, speed: 9 } },
  { match: /\b(32b|70b|72b|large|medium)\b/, set: { coding: 7, reasoning: 7, writing: 7, longContext: 6, speed: 6 } },
  { match: /\b(pro|max|plus|ultra|opus|sonnet|sol|terra|astra|k2|k3|v4|glm-5|grok-4|m2|m3|qwen3)/, set: { coding: 8, reasoning: 8, writing: 8, longContext: 8, speed: 6 } },
  { match: /(opus|fable|astra|v4-pro|grok-4\.6|glm-5\.3|kimi-k3|qwen3\.8-max)/, set: { coding: 9, reasoning: 9, writing: 9, longContext: 9, speed: 5 } },
  // specialties
  { match: /(coder|codestral|devstral|code|codex|grok-build)/, set: { coding: 9 } },
  { match: /(reason|think|r1|o3|o4|qwq)/, set: { reasoning: 9, speed: 4 } },
  { match: /(vl|vision|llava|pixtral|-v\b|omni)/, set: { vision: 8 } },
  { match: /(gemini|kimi|deepseek-v4|deepseek-flash|minimax|long)/, set: { longContext: 9 } },
];

const BASE: Skills = { coding: 6, reasoning: 6, writing: 6, longContext: 6, vision: 0, speed: 6 };

export function guessSkills(modelId: string): Skills {
  const id = modelId.toLowerCase();
  const skills: Skills = { ...BASE };
  for (const rule of RULES) {
    if (rule.match.test(id)) Object.assign(skills, rule.set);
  }
  // most frontier models read images; give the big families a basic vision score
  if (skills.vision === 0 && /(gpt-|claude|gemini|grok|sonnet|opus|fable|deepseek-flash|kimi)/.test(id)) skills.vision = 6;
  return skills;
}

export function makeModel(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { id, skills: guessSkills(id), ...extra };
}

/** Skip models that are clearly not chat models (embeddings, audio, moderation...). */
export function isChatModel(id: string): boolean {
  return !/(embed|embedding|whisper|tts|audio|moderation|rerank|dall-e|image-gen|transcribe|guard)/i.test(id);
}
