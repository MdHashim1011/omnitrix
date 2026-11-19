// Ollama's own API knows what each local model can do. The OpenAI-style model list does not say.
import { makeModel } from '../models.js';
import type { ModelInfo } from '../types.js';
import { getJson, postJson } from './http.js';

interface Tag {
  name?: string;
  digest?: string;
  details?: { parameter_size?: string };
}

/** The given models with capabilities, size and version from Ollama; a model it cannot describe gets plain local scores. */
export async function localModels(baseUrl: string, ids: string[]): Promise<ModelInfo[]> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  let tags: Tag[] = [];
  try {
    const list = await getJson(`${root}/api/tags`, {}, 5000);
    if (Array.isArray(list?.models)) tags = list.models;
  } catch {
    // not an Ollama server, or it is not running
  }
  const byName = new Map(tags.filter((t) => typeof t.name === 'string').map((t) => [t.name!, t]));
  return Promise.all(ids.map(async (id) => {
    const tag = byName.get(id);
    if (!tag) return makeModel(id, {}, { local: true });
    let capabilities: string[] | undefined;
    try {
      const shown = (await postJson(`${root}/api/show`, {}, { model: id }, 10_000)).json;
      if (Array.isArray(shown?.capabilities)) capabilities = shown.capabilities.filter((c: unknown) => typeof c === 'string');
    } catch {
      // older Ollama versions do not report capabilities; vision then stays unclaimed
    }
    const digest = typeof tag.digest === 'string' && /^[0-9a-f]{12,}$/i.test(tag.digest) ? tag.digest : undefined;
    return makeModel(id, digest ? { digest } : {}, { local: true, capabilities, parameterSize: tag.details?.parameter_size });
  }));
}
