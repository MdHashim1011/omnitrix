import { files, readJson, writeJson } from './store.js';
import type { TaskType } from './types.js';

/**
 * How often each model's work was accepted, per task type.
 * Old results fade out (half-life 30 days) so the router follows recent quality.
 */
interface Cell {
  ok: number;
  bad: number;
  at: number;
}
type Stats = Record<string, Cell>; // key: "model|taskType"

const HALF_LIFE = 30 * 24 * 3600_000;

function key(model: string, type: TaskType): string {
  return `${model}|${type}`;
}

function decay(cell: Cell, now: number): Cell {
  const f = Math.pow(0.5, (now - cell.at) / HALF_LIFE);
  return { ok: cell.ok * f, bad: cell.bad * f, at: now };
}

export function loadStats(): Stats {
  return readJson<Stats>(files.stats(), {});
}

/** Count a verdict. With `changed`, the job's earlier opposite verdict is taken back first. */
export function recordVerdict(model: string, type: TaskType, accepted: boolean, now = Date.now(), changed = false): void {
  const all = loadStats();
  const k = key(model, type);
  const cell = decay(all[k] ?? { ok: 0, bad: 0, at: now }, now);
  if (changed) {
    if (accepted) cell.bad = Math.max(0, cell.bad - 1);
    else cell.ok = Math.max(0, cell.ok - 1);
  }
  if (accepted) cell.ok += 1;
  else cell.bad += 1;
  all[k] = cell;
  writeJson(files.stats(), all);
}

/**
 * Multiplier between 0.6 and 1.4.
 * With no data it is 1.0. Two prior "virtual" results keep one lucky run from deciding everything.
 */
export function acceptanceFactor(stats: Stats, model: string, type: TaskType, now = Date.now()): { factor: number; samples: number } {
  const raw = stats[key(model, type)];
  if (!raw) return { factor: 1, samples: 0 };
  const c = decay(raw, now);
  const rate = (c.ok + 1) / (c.ok + c.bad + 2);
  // rate 0.5 (no signal) -> 1.0; all accepted -> up to 1.4; all rejected -> down to 0.6
  const factor = Math.min(1.4, Math.max(0.6, 0.5 + rate));
  return { factor, samples: Math.round(c.ok + c.bad) };
}
