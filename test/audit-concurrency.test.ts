import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { files, loadHealth, setSecret } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const closers: (() => unknown)[] = [];
beforeEach(() => {
  tempHome();
});
afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length) await closers.pop()!();
});

async function provider(reply: Parameters<typeof mockProvider>[0], ids = ['a']) {
  const p = await mockProvider(reply);
  closers.push(p.close);
  for (const id of ids) setSecret(id, 'sk-test-123456789012345');
  writeConfig(ids.map((id) => account({ id, baseUrl: p.url, apiKey: 'secret', concurrency: 4 })));
  return p;
}
const chats = (p: { calls: { path: string }[] }) => p.calls.filter((c) => c.path.endsWith('/chat/completions')).length;

describe('the queue', () => {
  it('starts each job once, even when a job fails before it reaches the provider', async () => {
    const p = await provider(() => ({ json: chatReply('ok') }));
    // a repository without a commit: making its worktree fails at once, before any provider is called
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-empty-'));
    spawnSync('git', ['init', '-q'], { cwd: empty });
    const engine = new Engine();
    const [bad, good] = engine.dispatch([
      { title: 'edit', type: 'code', prompt: 'p', repo: empty },
      { title: 'read', type: 'review', prompt: 'p' },
    ]);
    const done = await engine.wait([bad!.id, good!.id], 10);
    expect(done.find((j) => j.id === bad!.id)!.status).toBe('failed');
    const second = done.find((j) => j.id === good!.id)!;
    expect(second.status).toBe('done');
    expect(second.attempts).toHaveLength(1);
    expect(chats(p)).toBe(1);
  });
});

describe('empty answers', () => {
  it('are tried again on another account instead of being returned as a result', async () => {
    const p = await provider((_call, n) => ({ json: chatReply(n === 1 ? '   ' : 'real answer') }), ['a', 'b']);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'read', type: 'review', prompt: 'p' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('done');
    expect(done!.attempts).toHaveLength(2);
    expect(done!.attempts[0]!.error).toMatch(/empty answer/);
    expect(engine.readOutput(job!.id)).toBe('real answer');
    expect(chats(p)).toBe(2);
  });
});

describe('after the provider has answered', () => {
  it('a failure to save the answer fails the job without blaming the account or asking again', async () => {
    const p = await provider(() => ({ json: chatReply('answer') }), ['a', 'b']);
    const real = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.startsWith(files.outputs())) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return (real as (...a: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 'read', type: 'review', prompt: 'p' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(done!.attempts).toHaveLength(1);
    expect(done!.error).toMatch(/no space/);
    expect(chats(p)).toBe(1);
    expect(loadHealth()[done!.accountId!]?.state ?? 'ready').toBe('ready');
  });

  it('a slow success does not clear a pause set by a newer failure on the same account', async () => {
    await provider((_call, n) => (n === 1 ? { json: chatReply('slow'), delayMs: 1200 } : { status: 429, headers: { 'retry-after': '600' }, json: { error: { message: 'rate limit' } } }));
    const engine = new Engine();
    const [slow] = engine.dispatch([{ title: 'slow', type: 'review', prompt: 'p' }]);
    await new Promise((r) => setTimeout(r, 200));
    const [fast] = engine.dispatch([{ title: 'fast', type: 'review', prompt: 'p' }]);
    await engine.wait([slow!.id, fast!.id], 10);
    expect(engine.getJob(slow!.id)!.status).toBe('done');
    expect(loadHealth().a?.state).not.toBe('ready');
  });
});
