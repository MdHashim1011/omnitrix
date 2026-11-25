import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempHome } from './helpers.js';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');

// From a second computer's report: a free OpenRouter key was routed to paid models, and running the same
// "omnitrix add" twice made a second account on the same key.
describe('free keys and repeated adds', () => {
  const setup = () => {
    const home = tempHome();
    const env = { ...process.env, OMNITRIX_HOME: home, OR_KEY: 'or-test-0123456789', MS_KEY: 'ms-test-0123456789' };
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    const accounts = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).accounts as { id: string; freeOnly?: boolean; models: { id: string }[] }[];
    return { run, accounts };
  };

  it('keeps only the free models of an OpenRouter account', () => {
    const { run, accounts } = setup();
    expect(run('add', 'openrouter', '--key-env', 'OR_KEY', '--free-only', '--model', 'big-paid,small:free').status).toBe(0);
    expect(accounts()[0]).toMatchObject({ id: 'openrouter', freeOnly: true, models: [{ id: 'small:free' }] });
    // a list without any free model is refused rather than saved empty
    const none = run('add', 'openrouter', '--id', 'or2', '--key-env', 'OR_KEY', '--free-only', '--model', 'big-paid');
    expect(none.status).not.toBe(0);
    expect(none.stderr).toMatch(/none of the given ones/);
  }, 40_000);

  it('turns free-only on and off for an account that is already connected', () => {
    const { run, accounts } = setup();
    run('add', 'openrouter', '--key-env', 'OR_KEY', '--model', 'big-paid,small:free');
    expect(run('set', 'openrouter', '--free-only').status).toBe(0);
    expect(accounts()[0]).toMatchObject({ freeOnly: true, models: [{ id: 'small:free' }] });
    expect(run('set', 'openrouter', '--no-free-only').status).toBe(0);
    expect(accounts()[0]!.freeOnly).toBeUndefined();
    // other providers do not mark their free models, so the setting would remove every model
    run('add', 'mistral', '--key-env', 'MS_KEY', '--model', 'mistral-small-latest');
    const other = run('set', 'mistral', '--free-only');
    expect(other.status).not.toBe(0);
    expect(other.stderr).toMatch(/OpenRouter accounts only/);
  }, 40_000);

  it('refuses a second account on the same key unless --id asks for one', () => {
    const { run, accounts } = setup();
    expect(run('add', 'openrouter', '--key-env', 'OR_KEY', '--model', 'small:free').status).toBe(0);
    const again = run('add', 'openrouter', '--key-env', 'OR_KEY', '--model', 'small:free');
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/openrouter already connects OpenRouter with OR_KEY/);
    // a different key is a different account
    expect(run('add', 'openrouter', '--key-env', 'MS_KEY', '--model', 'small:free').status).toBe(0);
    expect(run('add', 'openrouter', '--id', 'or-second', '--key-env', 'OR_KEY', '--model', 'small:free').status).toBe(0);
    expect(accounts().map((a) => a.id)).toEqual(['openrouter', 'openrouter-2', 'or-second']);
    // the same address written in capitals or with a closing slash is the same account
    expect(run('add', 'openrouter', '--key-env', 'OR_KEY', '--base-url', 'HTTPS://OPENROUTER.AI/api/v1/', '--model', 'small:free').status).not.toBe(0);
  }, 60_000);

  it('lets a local server be added without a key next to one that uses a key', () => {
    const { run, accounts } = setup();
    expect(run('add', 'ollama', '--key-env', 'OR_KEY', '--model', 'llama3.2:3b').status).toBe(0);
    expect(run('add', 'ollama', '--model', 'llama3.2:3b').status).toBe(0);
    expect(run('add', 'ollama', '--model', 'llama3.2:3b').status).not.toBe(0);
    expect(accounts()).toHaveLength(2);
  }, 60_000);
});
