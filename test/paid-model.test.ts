import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyStatus } from '../src/drivers/http.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// Found on a second computer: free keys at OpenRouter and Mistral answer 402 for their paid models, and one
// such answer rested the whole account for an hour, free models included. A busy model at SambaNova did the same.
const strong = (id: string) => makeModel(id, { skills: { coding: 9, reasoning: 9, writing: 9, longContext: 9, vision: 0, speed: 8 } });
const weak = (id: string) => makeModel(id, { skills: { coding: 3, reasoning: 3, writing: 3, longContext: 3, vision: 0, speed: 3 } });
const paid = () => ({ status: 402, json: { error: { message: 'This request requires more credits.' } } });

describe('a model that needs payment or is busy', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it('reads 402 as the model needing payment, and "high demand" as a busy model', () => {
    expect(classifyStatus(402, '{"error":{"message":"This request requires more credits, or fewer max_tokens."}}')).toBe('paid_model');
    expect(classifyStatus(429, '{"error":{"message":"Model GLM-5.3 is under high demand, try again later"}}')).toBe('server');
    expect(classifyStatus(429, 'The model is overloaded')).toBe('server');
    expect(classifyStatus(429, 'Rate limit reached for requests')).toBe('rate_limit');
    // providers say "at capacity" about the account's own limit too, so it stays an account matter
    expect(classifyStatus(429, 'Your organization is at capacity')).toBe('rate_limit');
  });

  it('rests a paid model only as long as the provider says, when it says', async () => {
    tempHome();
    const or = await mockProvider((call) => (call.body?.model === 'big-paid' ? { ...paid(), headers: { 'retry-after': '30' } } : { json: chatReply('free answer') }));
    closers.push(or.close);
    writeConfig([account({ id: 'or', baseUrl: or.url, local: true, models: [strong('big-paid'), weak('small:free')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    await engine.wait([job!.id], 15);
    const health = JSON.parse(fs.readFileSync(path.join(process.env.OMNITRIX_HOME!, 'health.json'), 'utf8'));
    const until = Object.entries(health).find(([k]) => k.includes('big-paid'))![1] as { until: number };
    expect(until.until - Date.now()).toBeLessThan(60_000);
  }, 20_000);

  it('rests only the paid model, and the same account answers with its free one', async () => {
    tempHome();
    const or = await mockProvider((call) => (call.body?.model === 'big-paid' ? paid() : { json: chatReply('free answer') }));
    closers.push(or.close);
    writeConfig([account({ id: 'or', baseUrl: or.url, local: true, models: [strong('big-paid'), weak('small:free')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 15);
    expect(done).toMatchObject({ status: 'done', accountId: 'or', model: 'small:free' });
    const view = engine.pool().find((a) => a.id === 'or')!;
    expect(view.state).toBe('ready');
    expect(view.pausedModels).toEqual(['big-paid']);
    // the next job does not ask the paid model again
    const [next] = engine.dispatch([{ title: 't2', type: 'writing', prompt: 'q2' }]);
    await engine.wait([next!.id], 15);
    expect(or.calls.filter((c) => c.body?.model === 'big-paid')).toHaveLength(1);
  }, 20_000);

  it('stops trying an account after two of its models need payment', async () => {
    tempHome();
    const lab = await mockProvider(paid);
    const backup = await mockProvider(() => ({ json: chatReply('from backup') }));
    closers.push(lab.close, backup.close);
    writeConfig([
      account({ id: 'lab', baseUrl: lab.url, local: true, models: Array.from({ length: 6 }, (_, i) => strong(`lab-${i}`)) }),
      account({ id: 'backup', baseUrl: backup.url, local: true, models: [weak('backup-model')] }),
    ]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 15);
    expect(done).toMatchObject({ status: 'done', accountId: 'backup' });
    expect(lab.calls.filter((c) => c.body?.messages)).toHaveLength(2);
    // the account rests, so the next job does not try two more of its models
    expect(engine.pool().find((a) => a.id === 'lab')).toMatchObject({ state: 'exhausted', reason: 'two of its models need a paid plan or credits' });
    const [next] = engine.dispatch([{ title: 't2', type: 'writing', prompt: 'q2' }]);
    await engine.wait([next!.id], 15);
    expect(lab.calls.filter((c) => c.body?.messages)).toHaveLength(2);
    // and the account itself is not written into the task, so a retry of it may use the account again later
    expect(engine.getJob(job!.id)!.task.avoid ?? []).not.toContain('lab');
  }, 20_000);

  it('still rests an account whose only model needs payment', async () => {
    tempHome();
    const one = await mockProvider(paid);
    closers.push(one.close);
    writeConfig([account({ id: 'one', baseUrl: one.url, local: true, models: [strong('only')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    await engine.wait([job!.id], 15);
    expect(engine.pool().find((a) => a.id === 'one')!.state).toBe('exhausted');
  }, 20_000);

  it('moves on to the next model of the same account when one is under high demand', async () => {
    tempHome();
    const sn = await mockProvider((call) => (call.body?.model === 'top' ? { status: 429, json: { error: { message: 'high demand' } } } : { json: chatReply('second model') }));
    closers.push(sn.close);
    writeConfig([account({ id: 'sn', baseUrl: sn.url, local: true, models: [strong('top'), weak('second')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([job!.id], 15);
    expect(done).toMatchObject({ status: 'done', accountId: 'sn', model: 'second' });
    expect(engine.pool().find((a) => a.id === 'sn')!.state).toBe('ready');
  }, 20_000);
});
