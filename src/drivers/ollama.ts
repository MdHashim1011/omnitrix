// Ollama's own API knows what each local model can do. The OpenAI-style model list does not say.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeModel } from '../models.js';
import { resolveCommand } from './cli.js';
import type { ModelInfo } from '../types.js';
import { getJson, postJson } from './http.js';

interface Tag {
  name?: string;
  digest?: string;
  size?: number;
  details?: { parameter_size?: string };
}

/** Each local model's size in bytes, as Ollama reports it; empty when the server does not answer. */
export async function modelSizes(baseUrl: string): Promise<Record<string, number>> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  try {
    const list = await getJson(`${root}/api/tags`, {}, 5000);
    const out: Record<string, number> = {};
    for (const t of Array.isArray(list?.models) ? (list.models as Tag[]) : []) {
      if (typeof t.name === 'string' && typeof t.size === 'number' && t.size > 0) out[t.name] = t.size;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The working size in tokens that Ollama gave a loaded model, from /api/ps; undefined when it does not say.
 * When a prompt is longer, Ollama keeps only part of it, often about half of this size.
 */
export async function loadedContext(baseUrl: string, model: string, headers: Record<string, string> = {}): Promise<number | undefined> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  try {
    const ps = await getJson(`${root}/api/ps`, headers, 5000);
    const loaded = (Array.isArray(ps?.models) ? (ps.models as { name?: unknown; model?: unknown; context_length?: unknown }[]) : []).find((m) => m?.name === model || m?.model === model);
    const n = Number(loaded?.context_length);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Ollama's usual working size; a request that fits in it needs no size of its own. */
const OLLAMA_SMALLEST = 4096;
/** The largest working size omnitrix asks for on its own, since memory use grows with it. */
const OLLAMA_MOST = 32_768;

/**
 * The working size to ask Ollama for when a request needs `need` tokens, or undefined when its smallest
 * usual size is enough. A power of two keeps the same size for similar requests, since Ollama reloads a
 * model whose size changes. A larger size that is loaded already is kept for the same reason, and the
 * model's own limit is never passed.
 */
export function ollamaRoom(need: number, modelMax?: number, loaded?: number): number | undefined {
  if (need <= OLLAMA_SMALLEST) return undefined;
  let room = 4096;
  while (room < need && room < OLLAMA_MOST) room *= 2;
  room = Math.max(room, loaded ?? 0);
  return modelMax ? Math.min(room, modelMax) : room;
}

// a model can be replaced under the same name, so a size read from it is asked again after a while
const MAX_CACHE_MS = 10 * 60_000;
const maxCache = new Map<string, { max: number | undefined; at: number }>();

/**
 * The longest context a model was trained for, from /api/show; undefined when Ollama does not say. `headers`
 * carry the account key for a proxy in front of Ollama, and `signal` ends the question when the job is cancelled.
 */
export async function modelMaxContext(baseUrl: string, model: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<number | undefined> {
  const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const key = `${root} ${model}`;
  const hit = maxCache.get(key);
  if (hit && Date.now() - hit.at < MAX_CACHE_MS) return hit.max;
  try {
    const info = (await postJson(`${root}/api/show`, headers, { model }, 10_000, signal)).json?.model_info ?? {};
    const name = Object.keys(info).find((k) => k.endsWith('.context_length'));
    const n = Number(name ? info[name] : undefined);
    const max = Number.isFinite(n) && n > 0 ? n : undefined;
    maxCache.set(key, { max, at: Date.now() });
    return max;
  } catch {
    return undefined;
  }
}

let gpuCache: { bytes: number | undefined } | undefined;

/**
 * The memory of the largest NVIDIA graphics card, read once with nvidia-smi, or undefined without one.
 * A local model larger than this runs mostly on the processor, which is many times slower. Other cards
 * and Apple's shared memory are not read, so nothing changes for them.
 */
export function gpuMemoryBytes(): number | undefined {
  if (gpuCache) return gpuCache.bytes;
  gpuCache = { bytes: undefined };
  // resolveCommand skips the current folder on Windows, so a project cannot plant its own nvidia-smi
  const found = resolveCommand('nvidia-smi');
  if (!found || !path.isAbsolute(found.file) || found.shell) return undefined;
  const r = spawnSync(found.file, ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status === 0) gpuCache.bytes = parseGpuMemory(r.stdout ?? '');
  return gpuCache.bytes;
}

/** nvidia-smi prints one line per card with its memory in MiB, such as "4096"; the largest card counts. */
export function parseGpuMemory(stdout: string): number | undefined {
  const mib = stdout.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return mib.length ? Math.max(...mib) * 1024 * 1024 : undefined;
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
