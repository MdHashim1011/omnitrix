import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectsDir, formatOverhead, measureOverhead } from '../src/overhead.js';
import { files, writeJson } from '../src/store.js';
import { tempHome } from './helpers.js';

const NOW = Date.now();
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 24 * 3600_000;

function assistant(id: string, sessionId: string, tools: { name: string; id: string }[], output: number, msAgo = 60_000, text = false) {
  const content = [...(text ? [{ type: 'text', text: 'private words' }] : []), ...tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: { prompt: 'secret prompt' } }))];
  return JSON.stringify({ type: 'assistant', sessionId, timestamp: at(msAgo), uuid: `u-${id}-${Math.random()}`, message: { id, role: 'assistant', content, usage: { input_tokens: 5, cache_read_input_tokens: 90_000, output_tokens: output } } });
}
function result(toolUseId: string, content: unknown, msAgo = 30_000) {
  return JSON.stringify({ type: 'user', sessionId: 's1', timestamp: at(msAgo), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
}

let claude: string;
beforeEach(() => {
  tempHome();
  claude = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-claude-'));
});

function session(rel: string, lines: string[]) {
  const file = path.join(claude, 'projects', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe("Claude's own work on omnitrix", () => {
  it('counts the omnitrix tool calls, the tokens Claude wrote in those messages and the results it read, once each', async () => {
    const first = [
      assistant('m1', 's1', [{ name: 'mcp__omnitrix__dispatch', id: 'tu1' }], 100),
      // the same reply, split over a second line: its tokens count once
      assistant('m1', 's1', [], 100, 60_000, true),
      assistant('m2', 's2', [{ name: 'mcp__plugin_omnitrix_omnitrix__get_results', id: 'tu2' }], 50),
      // other tools, and a server whose name only contains the word, are not omnitrix
      assistant('m3', 's1', [{ name: 'Bash', id: 'tu3' }], 999),
      assistant('m4', 's1', [{ name: 'mcp__notomnitrix__dispatch', id: 'tu4' }], 999),
      // older than the period
      assistant('m5', 's1', [{ name: 'mcp__omnitrix__dispatch', id: 'tu5' }], 999, 40 * DAY),
      result('tu1', 'x'.repeat(400)),
      result('tu2', [{ type: 'text', text: 'y'.repeat(200) }, { type: 'image', source: {} }]),
      result('tu3', 'z'.repeat(5000)),
      result('tu5', 'z'.repeat(5000)),
      'not json at all, mentioning omnitrix and tool_result',
    ];
    session('proj/s1.jsonl', first);
    // a forked session copies the earlier lines; they are still one call and one reply
    session('proj/s1/subagents/fork.jsonl', first.slice(0, 2).concat(result('tu1', 'x'.repeat(400))));
    const m = await measureOverhead(path.join(claude, 'projects'), NOW - 30 * DAY);
    expect(m).toMatchObject({ calls: 2, byTool: { dispatch: 1, get_results: 1 }, outputTokens: 150, resultChars: 600, sessions: 2, files: 2, unreadable: 0 });
  });

  it('reads nothing but numbers: no prompt, answer or result text ends up in what it returns', async () => {
    session('p/s.jsonl', [assistant('m1', 's1', [{ name: 'mcp__omnitrix__dispatch', id: 't' }], 10, 60_000, true), result('t', 'secret result')]);
    const m = await measureOverhead(path.join(claude, 'projects'), NOW - DAY);
    expect(JSON.stringify(m)).not.toMatch(/secret|private/);
  });

  it('says so when there are no session files, or no omnitrix calls in them', async () => {
    const none = await measureOverhead(path.join(claude, 'missing'), 0);
    expect(none.found).toBe(false);
    expect(formatOverhead(none, undefined, 30)).toMatch(/No Claude Code session files found/);
    session('p/s.jsonl', [assistant('m1', 's1', [{ name: 'Bash', id: 't' }], 10)]);
    const quiet = await measureOverhead(path.join(claude, 'projects'), NOW - DAY);
    expect(formatOverhead(quiet, undefined, 30)).toMatch(/Claude made no omnitrix tool calls in the last 30 days \(1 session file read\)/);
  });

  it('puts the two sides next to each other without converting one into the other', () => {
    const text = formatOverhead(
      { found: true, files: 3, unreadable: 1, sessions: 2, calls: 12, byTool: { dispatch: 4, get_results: 6, rate_result: 2 }, outputTokens: 45_000, resultChars: 480_000 },
      { tokens: 3_000_000, acceptedTokens: 2_700_000 },
      30,
    );
    expect(text).toContain('Last 30 days, in 2 Claude Code sessions: Claude made 12 omnitrix tool calls (6 get_results, 4 dispatch, 2 rate_result).');
    expect(text).toContain('Claude wrote 45.0k output tokens in those replies, thinking included, and read about 120.0k tokens of omnitrix results.');
    expect(text).toContain('In the same period the workers used 2.7M tokens on work Claude accepted, 3.0M in all.');
    expect(text).toMatch(/not converted/);
    expect(text).toMatch(/1 session file could not be read/);
  });

  it('looks in CLAUDE_CONFIG_DIR when it is set, and in ~/.claude otherwise', () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: claude })).toBe(path.join(claude, 'projects'));
    expect(claudeProjectsDir({})).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });

  it('measures for the dashboard in the background, one run at a time, at most once per period', async () => {
    const { overheadReader } = await import('../src/dashboard.js');
    let runs = 0;
    let finish: (v: unknown) => void = () => {};
    const measure = () => {
      runs++;
      return new Promise<any>((resolve) => {
        finish = resolve;
      });
    };
    let now = 1_000_000;
    const read = overheadReader(10 * 60_000, measure, () => now);
    // the page never waits: nothing yet, and one measurement started
    expect(read()).toBeUndefined();
    expect(read()).toBeUndefined();
    expect(runs).toBe(1);
    finish({ found: true, files: 1, unreadable: 0, sessions: 1, calls: 3, byTool: {}, outputTokens: 1200, resultChars: 4000 });
    await new Promise((r) => setTimeout(r, 0));
    expect(read()).toEqual({ calls: 3, outputTokens: 1200, resultTokens: 1000 });
    now += 9 * 60_000;
    read();
    expect(runs).toBe(1);
    // after the period, the old figures stay on the page while a new run goes
    now += 2 * 60_000;
    expect(read()).toEqual({ calls: 3, outputTokens: 1200, resultTokens: 1000 });
    expect(runs).toBe(2);
    // even with no waiting period, a run still going is never started twice
    let slow = 0;
    const eager = overheadReader(0, () => {
      slow++;
      return new Promise<any>(() => {});
    }, () => now);
    eager();
    eager();
    expect(slow).toBe(1);
    // a failed run keeps the last figures and does not retry until the next period
    const failing = overheadReader(60_000, () => Promise.reject(new Error('x')), () => now);
    failing();
    await new Promise((r) => setTimeout(r, 0));
    expect(failing()).toBeUndefined();
  });

  it("keeps the dashboard page's script valid JavaScript", async () => {
    // seen while building this: a quote escaped for TypeScript lost its escape in the page and broke it
    const { PAGE } = await import('../src/dashboard.js');
    const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(PAGE).toContain(`>Claude: '+esc(fmt(o.outputTokens))+' written, '+esc(fmt(o.resultTokens))+' read<`);
  });

  it('shows nothing on the dashboard when Claude made no omnitrix calls', async () => {
    const { overheadReader } = await import('../src/dashboard.js');
    const read = overheadReader(60_000, async () => ({ found: true, files: 2, unreadable: 0, sessions: 0, calls: 0, byTool: {}, outputTokens: 0, resultChars: 0 }));
    read();
    await new Promise((r) => setTimeout(r, 0));
    expect(read()).toBeUndefined();
  });

  it('runs as omnitrix overhead, next to the workers\' accepted tokens, and as JSON', () => {
    session('p/s.jsonl', [assistant('m1', 's1', [{ name: 'mcp__omnitrix__dispatch', id: 't' }], 300), result('t', 'r'.repeat(4000))]);
    writeJson(path.join(files.jobs(), 'jdone0001.json'), {
      id: 'jdone0001', task: { title: 't', type: 'code', prompt: 'p' }, status: 'done', createdAt: NOW - 3600_000, updatedAt: NOW,
      attempts: [{ accountId: 'codex', model: 'm', startedAt: NOW - 3600_000, endedAt: NOW - 3500_000, ok: true }], accountId: 'codex', model: 'm',
      usage: { inputTokens: 9000, outputTokens: 1000 }, verdict: 'accepted',
    });
    writeJson(path.join(files.jobs(), 'jdone0002.json'), {
      id: 'jdone0002', task: { title: 't', type: 'review', prompt: 'p' }, status: 'done', createdAt: NOW - 3600_000, updatedAt: NOW,
      attempts: [{ accountId: 'codex', model: 'm', startedAt: NOW - 3600_000, endedAt: NOW - 3500_000, ok: true }], accountId: 'codex', model: 'm',
      usage: { inputTokens: 4000, outputTokens: 1000 }, verdict: 'rejected',
    });
    const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claude };
    const r = spawnSync(process.execPath, [cli, 'overhead'], { env, encoding: 'utf8' });
    expect(r.stdout).toContain('Claude made 1 omnitrix tool call (1 dispatch)');
    expect(r.stdout).toContain('the workers used 10.0k tokens on work Claude accepted, 15.0k in all');
    const j = JSON.parse(spawnSync(process.execPath, [cli, 'overhead', '--json'], { env, encoding: 'utf8' }).stdout);
    expect(j).toMatchObject({ days: 30, claude: { calls: 1, outputTokens: 300, resultTokens: 1000 }, workers: { acceptedTokens: 10000, tokens: 15000 } });
  }, 30_000);
});
