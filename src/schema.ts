import { z } from 'zod';
import type { JobStructured } from './types.js';

/** A schema longer than this is more likely a mistake than a format, and it fills the worker's prompt. */
const MAX_SCHEMA_CHARS = 20_000;
const MAX_ERRORS = 10;

/** Why this JSON Schema cannot be used, or undefined when it can. */
export function schemaProblem(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'a JSON Schema is an object, such as {"type": "object", "properties": {...}}';
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) return 'the schema is longer than 20,000 characters';
  try {
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return undefined;
}

/** The part of the prompt that asks for the format; it comes last, so the model reads it just before answering. */
export function answerFormat(schema: Record<string, unknown>): string[] {
  return [
    '## Answer format',
    'Answer with only one JSON value that matches this JSON Schema: no explanation before or after it, and no code fence.',
    '```json', JSON.stringify(schema, null, 2), '```',
  ];
}

/**
 * The JSON value in an answer. Models often wrap it in a code fence or a sentence despite the instruction,
 * so after the whole text this tries the first fenced block, then the span from the first bracket to the last.
 */
export function extractJson(text: string): { value: unknown } | undefined {
  const tries = [text.trim()];
  const fenced = /```(?:json)?[^\S\n]*\n([\s\S]*?)\n?```/.exec(text);
  if (fenced) tries.push(fenced[1]!.trim());
  const start = text.search(/[[{]/);
  if (start >= 0) {
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end > start) tries.push(text.slice(start, end + 1));
  }
  for (const t of tries) {
    try {
      return { value: JSON.parse(t) };
    } catch {
      // try the next way of reading it
    }
  }
  return undefined;
}

/** Whether the answer holds a JSON value that matches the schema, and if not, what is wrong. */
export function readStructured(text: string, schema: Record<string, unknown>): JobStructured {
  const found = extractJson(text);
  if (!found) return { status: 'not_json', errors: ['the answer contains no JSON value'] };
  const r = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(found.value);
  if (r.success) return { status: 'valid' };
  return { status: 'invalid', errors: r.error.issues.slice(0, MAX_ERRORS).map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`.slice(0, 300)) };
}
