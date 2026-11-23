// How much of Claude's own work went into running omnitrix, read from the session files that Claude Code keeps
// on this computer. Only numbers come out of here: no prompt, answer or result text is kept or printed.
// The file format is Claude Code's own and is not documented, so anything unexpected is skipped, never guessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { formatTokens } from './usage.js';

export interface Overhead {
  /** whether the session folder exists at all */
  found: boolean;
  /** session files read, and those that could not be */
  files: number;
  unreadable: number;
  /** Claude Code sessions that called omnitrix */
  sessions: number;
  /** omnitrix tool calls, in total and per tool */
  calls: number;
  byTool: Record<string, number>;
  /** output tokens of Claude's replies that called omnitrix, thinking included */
  outputTokens: number;
  /** characters of the omnitrix results Claude read */
  resultChars: number;
}

/** omnitrix's tools, registered directly ("mcp__omnitrix__dispatch") or by the plugin ("mcp__plugin_omnitrix_omnitrix__dispatch") */
const TOOL = /^mcp__(?:.+_)?omnitrix__([a-z_]+)$/;
/** Session files sit in a folder per project, and a session's subagents one or two levels further down. */
const DEPTH = 4;

export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

function sessionFiles(dir: string, since: number, depth: number, out: string[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < DEPTH) sessionFiles(p, since, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        // a file last written before the period holds nothing from it
        if (fs.statSync(p).mtimeMs >= since) out.push(p);
      } catch {
        // gone meanwhile
      }
    }
  }
  return out;
}

function textLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) if (c && c.type === 'text' && typeof c.text === 'string') n += c.text.length;
  return n;
}

export async function measureOverhead(dir: string, since: number): Promise<Overhead> {
  const out: Overhead = { found: fs.existsSync(dir), files: 0, unreadable: 0, sessions: 0, calls: 0, byTool: {}, outputTokens: 0, resultChars: 0 };
  // A reply can be split over several lines with the same message id, and a forked or resumed session copies
  // earlier lines into a new file, so every call, reply and result is counted once by its id.
  const calls = new Set<string>();
  const replies = new Map<string, number>();
  const results = new Map<string, number>();
  const sessions = new Set<string>();
  for (const file of out.found ? sessionFiles(dir, since, 0, []) : []) {
    out.files++;
    try {
      const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        // most lines are neither; skip them before parsing, since session files can be large
        if (!line.includes('omnitrix') && !line.includes('"tool_result"')) continue;
        let j: any;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        const t = Date.parse(j?.timestamp);
        const content = j?.message?.content;
        if (!(t >= since) || !Array.isArray(content)) continue;
        if (j.type === 'assistant') {
          let ours = false;
          for (const c of content) {
            const m = c?.type === 'tool_use' && typeof c.name === 'string' && typeof c.id === 'string' ? TOOL.exec(c.name) : null;
            if (!m) continue;
            ours = true;
            if (calls.has(c.id)) continue;
            calls.add(c.id);
            out.byTool[m[1]!] = (out.byTool[m[1]!] ?? 0) + 1;
          }
          const n = j.message.usage?.output_tokens;
          const id = j.message.id;
          if (ours && typeof id === 'string' && typeof n === 'number' && Number.isFinite(n) && n >= 0) {
            replies.set(id, Math.max(replies.get(id) ?? 0, n));
            if (typeof j.sessionId === 'string') sessions.add(j.sessionId);
          }
        } else if (j.type === 'user') {
          for (const c of content) {
            if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string' && calls.has(c.tool_use_id)) results.set(c.tool_use_id, textLength(c.content));
          }
        }
      }
    } catch {
      out.unreadable++;
    }
  }
  out.calls = calls.size;
  out.sessions = sessions.size;
  for (const n of replies.values()) out.outputTokens += n;
  for (const n of results.values()) out.resultChars += n;
  return out;
}

/** About four characters to a token, for English text and code. */
export const resultTokens = (o: Overhead): number => Math.round(o.resultChars / 4);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The measurement as text, next to the workers' tokens when the job records give them. */
export function formatOverhead(o: Overhead, workers: { tokens: number; acceptedTokens: number } | undefined, days: number): string {
  if (!o.found) return 'No Claude Code session files found on this computer.';
  if (!o.calls) return `Claude made no omnitrix tool calls in the last ${days} days (${plural(o.files, 'session file')} read).`;
  const tools = Object.entries(o.byTool).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${n} ${k}`).join(', ');
  const lines = [
    `Last ${days} days, in ${plural(o.sessions, 'Claude Code session')}: Claude made ${plural(o.calls, 'omnitrix tool call')} (${tools}).`,
    `Claude wrote ${formatTokens(o.outputTokens)} output tokens in those replies, thinking included, and read about ${formatTokens(resultTokens(o))} tokens of omnitrix results.`,
  ];
  if (workers) lines.push(`In the same period the workers used ${formatTokens(workers.acceptedTokens)} tokens on work Claude accepted, ${formatTokens(workers.tokens)} in all.`);
  lines.push(
    '',
    "Claude's tokens come out of your Claude limit and the workers' out of your other accounts, and the two are not the same cost, so they are shown side by side, not converted.",
    'Not counted: planning that Claude did before it called omnitrix, and results it reads again on later turns, which are usually cached.',
  );
  if (o.unreadable) lines.push(`${plural(o.unreadable, 'session file')} could not be read.`);
  return lines.join('\n');
}
