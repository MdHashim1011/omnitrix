import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { buildServer, jobView } from '../src/mcp.js';
import { makeModel } from '../src/models.js';
import { saveHealth } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const outOfCredit = { status: 429, json: { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota' } } };
const task = { title: 't', type: 'review' as const, prompt: 'Judge the two answers.' };

async function provider(reply: { status?: number; json: unknown }) {
  const p = await mockProvider(() => reply);
  cleanups.push(p.close);
  return p;
}

/** Gemini, which the task forces, and Groq, which could take it as well. */
async function pool(gemini: { status?: number; json: unknown } = { json: chatReply('from gemini') }) {
  const g = await provider(gemini);
  const q = await provider({ json: chatReply('from groq') });
  writeConfig([
    account({ id: 'gemini', baseUrl: g.url, local: true, models: [makeModel('gemini-flash')] }),
    account({ id: 'groq', baseUrl: q.url, local: true, models: [makeModel('llama-70b')] }),
  ]);
  return { g, q };
}

const outUntil = (ms: number) => ({ gemini: { state: 'exhausted' as const, until: Date.now() + ms, reason: 'You exceeded your current quota' } });

// From the owner's laptop: Claude forced review jobs onto Gemini while Gemini was out of quota, and they failed
describe('a task that forces an account that cannot serve', () => {
  it('goes to another account at once and says so', async () => {
    const { g } = await pool();
    saveHealth(outUntil(3600_000));
    const engine = new Engine();
    const started = Date.now();
    const [job] = engine.dispatch([{ ...task, use: 'gemini' }]);
    // moved and started in the same pass that found Gemini out, not a second later
    expect(engine.getJob(job!.id)).toMatchObject({ status: 'running', accountId: 'groq' });
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'groq' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(g.calls).toHaveLength(0);
    expect(done!.movedFrom).toEqual({ use: 'gemini', reason: expect.stringMatching(/^exhausted until/), attempts: 0 });
    expect(jobView(done!, false, engine).moved).toMatch(/^gemini could not take it \(exhausted until .*\), so omnitrix ran it on groq\/llama-70b instead$/);
  });

  it('moves when the forced account runs out during the job', async () => {
    await pool(outOfCredit);
    const engine = new Engine();
    const [job] = engine.dispatch([{ ...task, use: 'gemini/gemini-flash' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'groq' });
    expect(done!.attempts.map((a) => `${a.accountId}:${a.errorKind ?? 'ok'}`)).toEqual(['gemini:quota', 'groq:ok']);
    expect(done!.task.avoid).toContain('gemini/gemini-flash');
  });

  it('moves when the forced account answers with nonsense', async () => {
    await pool({ json: { something: 'odd' } });
    const engine = new Engine();
    const [job] = engine.dispatch([{ ...task, use: 'gemini' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'groq' });
    expect(done!.attempts.map((a) => a.accountId)).toEqual(['gemini', 'groq']);
  });

  it('stays with the forced account when the task is strict', async () => {
    await pool();
    saveHealth(outUntil(3600_000));
    const engine = new Engine();
    const [job] = engine.dispatch([{ ...task, use: 'gemini', strict: true }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(done!.error).toMatch(/gemini: exhausted until/);
    expect(done!.movedFrom).toBeUndefined();
    expect(() => engine.dispatch([{ ...task, strict: true }])).toThrow(/strict .* needs use/);
  });

  it('lets a retry of a strict task go elsewhere, as every retry may', async () => {
    await pool();
    const engine = new Engine();
    const [kept] = engine.dispatch([{ ...task, use: 'gemini', strict: true }]);
    expect((await engine.wait([kept!.id], 10))[0]).toMatchObject({ status: 'done', accountId: 'gemini' });
    const again = engine.retry(kept!.id, 'too short');
    expect(again!.task.strict).toBeUndefined();
    expect((await engine.wait([again!.id], 10))[0]).toMatchObject({ status: 'done', accountId: 'groq' });
  });

  it('does not let a rest hide a mistake in the task', async () => {
    await pool();
    // Gemini is signed out, and the task also names a model Gemini does not have
    saveHealth({ gemini: { state: 'auth_error', reason: 'key rejected' } });
    const engine = new Engine();
    const [typo] = engine.dispatch([{ ...task, use: 'gemini/no-such-model' }]);
    const [done] = await engine.wait([typo!.id], 10);
    expect(done!.status).toBe('failed');
    expect(done!.movedFrom).toBeUndefined();
  });

  it('moves when one model of the forced account could take the task but rests', async () => {
    // a secret task: the account's cloud model never could, its local model could but is paused
    const g = await provider({ json: chatReply('from box') });
    const q = await provider({ json: chatReply('from groq') });
    writeConfig([
      account({ id: 'box', baseUrl: g.url, local: true, models: [makeModel('small-local'), makeModel('gpt-oss:20b-cloud')] }),
      account({ id: 'groq', baseUrl: q.url, local: true, models: [makeModel('llama-70b')] }),
    ]);
    saveHealth({ 'box/small-local': { state: 'cooling', until: Date.now() + 3600_000, reason: 'overloaded' } });
    const engine = new Engine();
    const [job] = engine.dispatch([{ ...task, use: 'box', privacy: 'secret' as const }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'groq' });
  });

  it('says so when no other account could take a moved task either', async () => {
    await pool();
    saveHealth({ ...outUntil(3600_000), groq: { state: 'exhausted', until: Date.now() + 3600_000, reason: 'quota' } });
    const engine = new Engine();
    const [job] = engine.dispatch([{ ...task, use: 'gemini' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(jobView(done!, false, engine).moved).toMatch(/so omnitrix tried other accounts, but none could take it either$/);
  });

  it('does not claim a moved task ran on the account that had just failed it', async () => {
    await pool(outOfCredit);
    saveHealth({ groq: { state: 'exhausted', until: Date.now() + 3600_000, reason: 'quota' } });
    const engine = new Engine();
    const [job] = engine.dispatch([{ ...task, use: 'gemini' }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'failed', accountId: 'gemini' });
    expect(jobView(done!, false, engine).moved).toMatch(/none could take it either$/);
  });

  it('retries a follow-up elsewhere without adding the earlier task twice', async () => {
    const { q } = await pool();
    const engine = new Engine();
    const [first] = engine.dispatch([{ ...task, use: 'gemini' }]);
    await engine.wait([first!.id], 10);
    const [next] = engine.dispatch([{ ...task, prompt: 'Now score them.', followUpOf: first!.id }]);
    expect((await engine.wait([next!.id], 10))[0]).toMatchObject({ status: 'done', accountId: 'gemini' });
    const again = engine.retry(next!.id, 'no scores given');
    expect((await engine.wait([again!.id], 10))[0]).toMatchObject({ status: 'done', accountId: 'groq' });
    const sent = JSON.stringify(q.calls.at(-1)!.body);
    expect(sent.split('## Earlier task')).toHaveLength(2);
    expect(sent).toContain('## The earlier answer');
    expect(sent).toContain('no scores given');
  });

  it('still fails on a mistake in the task, which another account would not fix', async () => {
    const { g, q } = await pool();
    // a cloud account beside the two on this computer
    writeConfig([
      account({ id: 'gemini', baseUrl: g.url, local: true, models: [makeModel('gemini-flash')] }),
      account({ id: 'groq', baseUrl: q.url, local: true, models: [makeModel('llama-70b')] }),
      account({ id: 'cloud', baseUrl: 'https://api.example.com/v1', models: [makeModel('big-model')] }),
    ]);
    const engine = new Engine();
    const [typo] = engine.dispatch([{ ...task, use: 'gemini/no-such-model' }]);
    // a secret task may not go to a cloud account, and moving it would hide that
    const [secret] = engine.dispatch([{ ...task, use: 'cloud', privacy: 'secret' as const }]);
    const done = await engine.wait([typo!.id, secret!.id], 10);
    expect(done.map((j) => j.status)).toEqual(['failed', 'failed']);
    expect(done[0]!.error).toMatch(/model no-such-model not on this account/);
    expect(done[1]!.error).toMatch(/secret task: local models only/);
    expect(done.every((j) => !j.movedFrom)).toBe(true);
  });

  it('moves a follow-up whose model ran out, with the earlier answer named as such', async () => {
    const { q } = await pool();
    const engine = new Engine();
    const [first] = engine.dispatch([{ ...task, use: 'gemini' }]);
    await engine.wait([first!.id], 10);
    saveHealth(outUntil(3600_000));
    const [next] = engine.dispatch([{ ...task, prompt: 'Now score them.', followUpOf: first!.id }]);
    const [done] = await engine.wait([next!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'groq' });
    const sent = JSON.stringify(q.calls.at(-1)!.body);
    expect(sent).toContain('## The earlier answer');
    expect(sent).toContain('from gemini');
  });

  it('reports the move within the output schema of get_results', async () => {
    await pool();
    saveHealth(outUntil(3600_000));
    const engine = new Engine();
    const server = buildServer(engine);
    const [one, two] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(one), client.connect(two)]);
    cleanups.push(() => client.close());
    // a client checks answers against the output schemas only once it has listed the tools
    await client.listTools();
    const sent: any = await client.callTool({ name: 'dispatch', arguments: { tasks: [{ ...task, use: 'gemini' }] } });
    const got: any = await client.callTool({ name: 'get_results', arguments: { job_ids: sent.structuredContent.job_ids, wait_seconds: 10 } });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent.jobs[0].moved).toMatch(/^gemini could not take it/);
  });

  it('tells someone who forced an account on the command line that the task moved', async () => {
    await pool();
    saveHealth(outUntil(3600_000));
    // not spawnSync: the mock providers answer from this process, which must keep running meanwhile
    const run = (...args: string[]) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [path.resolve('dist/cli.js'), 'run', ...args], { env: { ...process.env, OMNITRIX_HOME: home } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    const moved = await run('--use', 'gemini', '--quiet', 'Judge', 'them.');
    expect(moved.stdout.trim()).toBe('from groq');
    expect(moved.stderr).toMatch(/gemini could not take it \(exhausted until .*\), so it went to another account/);
    const strict = await run('--use', 'gemini', '--strict', 'Judge', 'them.');
    expect(strict.status).toBe(1);
    expect(strict.stderr).toMatch(/gemini: exhausted until/);
  }, 30_000);
});
