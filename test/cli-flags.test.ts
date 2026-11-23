import { describe, expect, it } from 'vitest';
import { CLI_TOOLS } from '../src/drivers/cli.js';

const args = (tool: string, edit: boolean, model = 'some-model') => CLI_TOOLS[tool]!.args({ model, edit, cwd: '/w', outFile: '/o.txt' });

describe('flags passed to each agent CLI, as their documentation describes them', () => {
  it('Qwen Code spells its approval mode with a hyphen', () => {
    expect(args('qwen', true)).toEqual(expect.arrayContaining(['--approval-mode', 'auto-edit']));
    expect(args('qwen', true)).not.toContain('auto_edit');
  });

  it('Gemini CLI spells its approval mode with an underscore', () => {
    expect(args('gemini', true)).toEqual(expect.arrayContaining(['--approval-mode', 'auto_edit']));
  });

  it('Claude Code gets a short prompt with -p and reads the task from standard input, as documented', () => {
    const a = args('claude', false);
    expect(a[0]).toBe('-p');
    expect(a[1]).toMatch(/standard input/);
    expect(a).toEqual(expect.arrayContaining(['--permission-prompts', 'none', '--permission-mode', 'dontAsk']));
  });

  it('Antigravity CLI accepts edits for code tasks with its documented --mode, and the documented --model', () => {
    expect(args('agy', true)).toEqual(expect.arrayContaining(['--mode', 'accept-edits', '--model', 'some-model']));
    expect(args('agy', false)).not.toContain('--mode');
  });

  it('OpenCode takes the documented --model flag', () => {
    expect(args('opencode', false)).toEqual(['run', '--model', 'some-model']);
  });
});

describe('reading the answer of an agent CLI', () => {
  const qwenAnswer = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
    { type: 'result', result: 'the real answer', usage: { input_tokens: 120, output_tokens: 30 } },
  ];

  it('takes the result from the list of messages that Qwen Code prints, on one line or several', () => {
    for (const stdout of [JSON.stringify(qwenAnswer), JSON.stringify(qwenAnswer, null, 2)]) {
      const r = CLI_TOOLS.qwen!.parse(stdout, '/nonexistent');
      expect(r.text).toBe('the real answer');
      expect(r.inputTokens).toBe(120);
      expect(r.outputTokens).toBe(30);
    }
  });

  it('still reads the single JSON object that Gemini CLI prints', () => {
    const r = CLI_TOOLS.gemini!.parse(JSON.stringify({ response: 'gemini answer', stats: { models: { 'gemini-3-flash': { tokens: { prompt: 10, candidates: 5 } } } } }), '/nonexistent');
    expect(r).toMatchObject({ text: 'gemini answer', inputTokens: 10, outputTokens: 5 });
  });
});

describe('omnitrix mcp-config', () => {
  it('prints a server entry other MCP apps can use, with this node and this omnitrix, that really starts the server', async () => {
    const { execFileSync, spawn } = await import('node:child_process');
    const p = await import('node:path');
    const cliPath = p.resolve(__dirname, '..', 'dist', 'cli.js');
    const out = execFileSync(process.execPath, [cliPath, 'mcp-config'], { encoding: 'utf8' });
    const entry = JSON.parse(out).mcpServers.omnitrix;
    expect(entry).toEqual({ type: 'stdio', command: process.execPath, args: [cliPath, 'mcp'] });
    // the printed command must answer an MCP initialize request
    const child = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const reply = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        if (buf.includes('\n')) resolve(buf);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    });
    child.kill();
    expect(JSON.parse(reply).result.serverInfo.name).toBe('omnitrix');
  }, 30_000);
});
