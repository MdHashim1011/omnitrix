import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_TOOLS } from '../src/drivers/cli.js';
import { Engine } from '../src/engine.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const closers: (() => unknown)[] = [];
beforeEach(() => tempHome());
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('thinking level', () => {
  it('asks an API model for the requested reasoning effort', async () => {
    const p = await mockProvider(() => ({ json: chatReply('ok') }));
    closers.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const [high] = engine.dispatch([{ title: 'hard', type: 'reasoning', prompt: 'q', effort: 'high' }]);
    await engine.wait([high!.id], 5);
    const [plain] = engine.dispatch([{ title: 'easy', type: 'reasoning', prompt: 'q' }]);
    await engine.wait([plain!.id], 5);
    expect(p.calls[0]!.body.reasoning_effort).toBe('high');
    // without a level the provider's own default applies, so nothing is sent
    expect(p.calls[1]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('passes the level to Codex as a config setting', () => {
    const args = CLI_TOOLS.codex!.args({ model: 'default', edit: false, cwd: '.', outFile: 'out.txt', effort: 'high' });
    const i = args.indexOf('-c');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('model_reasoning_effort=high');
    expect(CLI_TOOLS.codex!.args({ model: 'default', edit: false, cwd: '.', outFile: 'out.txt' })).not.toContain('model_reasoning_effort=high');
  });
});
