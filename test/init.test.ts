import { afterEach, describe, expect, it } from 'vitest';
import { detect, type DetectDeps } from '../src/init.js';
import { PROVIDERS } from '../src/providers.js';
import { defaultSettings } from '../src/store.js';
import type { Account, Config } from '../src/types.js';
import { account, mockProvider } from './helpers.js';

const config = (accounts: Account[] = []): Config => ({ version: 1, accounts, settings: { ...defaultSettings } });
const nothing: DetectDeps = { env: {}, has: () => false, reachable: async () => false, providers: PROVIDERS };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe('omnitrix init: detect', () => {
  it('finds installed agent CLIs, keys in the environment and local servers that answer', async () => {
    const found = await detect(config(), {
      ...nothing,
      env: { DEEPSEEK_API_KEY: 'sk-secretvalue1234567890', GROQ_API_KEY: '' },
      has: (cmd) => cmd === 'codex' || cmd === 'qwen',
      reachable: async (url) => url.startsWith('http://localhost:11434'),
    });
    const byId = Object.fromEntries(found.map((f) => [f.provider, f]));
    expect(Object.keys(byId).sort()).toEqual(['codex', 'deepseek', 'ollama', 'qwen-code']);
    expect(byId.deepseek!.how).toBe('DEEPSEEK_API_KEY is set');
    expect(byId.ollama!.how).toBe('answering at http://localhost:11434/v1');
    expect(byId.codex!.how).toBe('the codex command is installed');
    // an empty variable is not a key, and no key value ever appears
    expect(JSON.stringify(found)).not.toContain('secretvalue');
    expect(found.every((f) => f.action === 'add')).toBe(true);
  });

  it('marks providers that are already connected', async () => {
    const found = await detect(config([account({ id: 'deepseek-main', provider: 'deepseek' })]), { ...nothing, env: { DEEPSEEK_API_KEY: 'x' } });
    expect(found).toEqual([expect.objectContaining({ provider: 'deepseek', action: 'connected', connectedAs: ['deepseek-main'] })]);
  });

  it('never adds Claude Code or Antigravity on its own, and says why', async () => {
    const found = await detect(config(), { ...nothing, has: (cmd) => cmd === 'claude' || cmd === 'agy' });
    expect(found.map((f) => [f.provider, f.action])).toEqual([['claude-code', 'skip'], ['antigravity', 'skip']]);
    expect(found.find((f) => f.provider === 'claude-code')!.reason).toMatch(/lead/);
    expect(found.find((f) => f.provider === 'antigravity')!.reason).toMatch(/suspend/);
  });

  it('needs the Gemini CLI to be installed, not only a Gemini key', async () => {
    const found = await detect(config(), { ...nothing, env: { GEMINI_API_KEY: 'k' } });
    expect(found.map((f) => f.provider)).toEqual(['gemini']);
  });

  it('probes a local server for real', async () => {
    const server = await mockProvider(() => ({ json: { data: [{ id: 'llama3.2:3b' }] } }));
    closers.push(server.close);
    const local = { id: 'ollama', name: 'Ollama (local)', driver: 'openai' as const, baseUrl: `${server.url}`, local: true };
    const down = { ...local, id: 'lmstudio', name: 'LM Studio (local)', baseUrl: 'http://127.0.0.1:9/v1' };
    const found = await detect(config(), { env: {}, has: () => false, providers: [local, down] });
    expect(found.map((f) => f.provider)).toEqual(['ollama']);
    expect(server.calls[0]!.path).toMatch(/\/models$/);
  });
});

describe('omnitrix init command', () => {
  it('lists what it found and changes nothing without --apply', async () => {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { tempHome } = await import('./helpers.js');
    const home = tempHome();
    const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const r = spawnSync(process.execPath, [cli, 'init'], { env: { ...process.env, OMNITRIX_HOME: home, DEEPSEEK_API_KEY: 'sk-initsecret0123456789' }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\+ DeepSeek\s+DEEPSEEK_API_KEY is set/);
    expect(r.stdout).toContain('Nothing was changed');
    expect(r.stdout + r.stderr).not.toContain('initsecret');
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
  }, 30_000);
});

describe('omnitrix init: CLIs that need a key or a login', () => {
  it('lists the Gemini CLI without adding it when its key is missing', async () => {
    const found = await detect(config(), { ...nothing, has: (cmd) => cmd === 'gemini' });
    expect(found).toEqual([expect.objectContaining({ provider: 'gemini-cli', action: 'skip', reason: expect.stringMatching(/GEMINI_API_KEY/) })]);
    const withKey = await detect(config(), { ...nothing, has: (cmd) => cmd === 'gemini', env: { GEMINI_API_KEY: 'k' } });
    expect(withKey.find((f) => f.provider === 'gemini-cli')!.action).toBe('add');
  });

  it('connects a CLI that needs a key with a reference to its variable, and tells you to sign in otherwise', async () => {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { tempHome } = await import('./helpers.js');
    const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const home = tempHome();
    const env = { ...process.env, OMNITRIX_HOME: home, GEMINI_API_KEY: 'gm-initsecret0123456789' };
    const gem = spawnSync(process.execPath, [cli, 'add', 'gemini-cli'], { env, encoding: 'utf8', timeout: 20_000 });
    expect(gem.status).toBe(0);
    const qwen = spawnSync(process.execPath, [cli, 'add', 'qwen-code'], { env, encoding: 'utf8', timeout: 20_000 });
    expect(qwen.stdout).toMatch(/next: omnitrix login qwen-code/);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(saved.accounts.find((a: { provider: string }) => a.provider === 'gemini-cli').apiKey).toBe('env:GEMINI_API_KEY');
    expect(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).not.toContain('initsecret');
  }, 40_000);

  it('creates nothing without --apply', async () => {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-test-')), 'not-yet');
    const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
    const r = spawnSync(process.execPath, [cli, 'init'], { env: { ...process.env, OMNITRIX_HOME: home }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
  }, 30_000);
});
