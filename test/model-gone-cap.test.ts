import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// A model with no allowance is normally dropped from the account. The drop is a write to config.json,
// which can fail or be undone by another process, so the job must make progress without it.
vi.mock('../src/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/store.js')>()),
  dropModel: () => { throw new Error('config is locked'); },
}));

const noAllowance = (call: { body: { model: string } }) => ({ status: 429, json: { error: { message: `Quota exceeded, limit: 0, model: ${call.body.model}` } } });

describe('model with no allowance that cannot be dropped', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it('is not tried twice, and the job moves on to a backup', async () => {
    tempHome();
    const gem = await mockProvider(noAllowance);
    const backup = await mockProvider(() => ({ json: chatReply('from backup') }));
    closers.push(gem.close, backup.close);
    writeConfig([
      account({ id: 'gem', baseUrl: gem.url, local: true, models: [makeModel('gemini-pro')] }),
      account({ id: 'backup', baseUrl: backup.url, local: true, models: [makeModel('llama3.2:3b')] }),
    ]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 15);
    expect(done!.status).toBe('done');
    expect(done!.accountId).toBe('backup');
    expect(gem.calls).toHaveLength(1);
    // the model rests, so other jobs skip it too even though it is still in the config
    const [next] = engine.dispatch([{ title: 't2', type: 'writing', prompt: 'q2' }]);
    await engine.wait([next!.id], 15);
    expect(gem.calls).toHaveLength(1);
  }, 20_000);

  it('stops after a bounded number of tries', async () => {
    tempHome();
    const gem = await mockProvider(noAllowance);
    closers.push(gem.close);
    const models = Array.from({ length: 14 }, (_, i) => makeModel(`gemini-pro-${i}`));
    writeConfig([account({ id: 'gem', baseUrl: gem.url, local: true, models })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 15);
    expect(done!.status).toBe('failed');
    expect(done!.attempts.length).toBe(12);
    expect(new Set(gem.calls.map((c) => c.body.model)).size).toBe(12);
  }, 20_000);
});
