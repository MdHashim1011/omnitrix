import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { contextLimitKey } from '../src/router.js';
import { loadHealth, saveHealth } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// Seen on a real Ollama 0.40.13: a prompt of about 22,000 tokens reached llama3.2:3b as 2,050 tokens,
// without an error, and the model answered a question about the missing start with confidence. The model
// itself takes 131,072 tokens; Ollama's default working size cut the rest.

const cleanups: (() => unknown)[] = [];

/**
 * One reply in both of Ollama's forms: the OpenAI-style answer, and the native one that omnitrix uses for a
 * long prompt. These fakes ignore the working size asked for, as an Ollama that cuts prompts anyway would.
 */
const reply = (text: string, read: number) => ({ ...chatReply(text, { prompt_tokens: read, completion_tokens: 2 }), message: { role: 'assistant', content: text }, prompt_eval_count: read, eval_count: 2 });
beforeEach(() => tempHome());
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const long = `The secret word is PELICAN.\n${'Line: the weather report says nothing important today.\n'.repeat(1500)}What is the secret word?`;
const task = (prompt: string, over = {}) => ({ title: 't', type: 'long_context' as const, prompt, ...over });

/** A local server that reads at most `limit` tokens of a prompt, as Ollama does, and says how many it read. */
async function cutting(limit: number, answer = 'Nothing', room?: number) {
  const p = await mockProvider((req) => {
    // Ollama's list of loaded models, with the working size it gave each one
    // what the model was trained for; these fakes do not say
    if (req.path.endsWith('/api/show')) return { json: {} };
    if (req.path.endsWith('/api/ps')) return { json: room ? { models: [{ name: 'qwen3:32b', context_length: 40_960 }, { name: 'llama3.2:3b', context_length: room }] } : { models: [] } };
    const sent = Math.round(JSON.stringify(req.body.messages).length / 4);
    return { json: reply(answer, Math.min(sent, limit)) };
  });
  cleanups.push(p.close);
  return p;
}

describe('a prompt that the model only read in part', () => {
  it('is not taken as an answer: another model gets the task, and the cut one is remembered', async () => {
    const small = await cutting(2050);
    const big = await cutting(200_000, 'PELICAN');
    writeConfig([
      account({ id: 'ollama', provider: 'ollama', baseUrl: small.url, local: true, models: [makeModel('llama3.2:3b')] }),
      // a smaller model ranks lower, so the cut one is tried first
      account({ id: 'other', baseUrl: big.url, local: true, models: [makeModel('llama3.2:1b')] }),
    ]);
    const engine = new Engine();
    const [job] = engine.dispatch([task(long, { privacy: 'secret' })]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done).toMatchObject({ status: 'done', accountId: 'other' });
    expect(done!.attempts[0]).toMatchObject({ accountId: 'ollama', errorKind: 'too_long' });
    expect(done!.attempts[0]!.error).toMatch(/read only 2,050 of about [\d,]+ tokens/);
    expect(loadHealth()[contextLimitKey('ollama', 'llama3.2:3b')]).toMatchObject({ contextTokens: 2050 });
  });

  it('moves on to another model of the same account', async () => {
    // only the bigger model is set up with a small working size
    const p = await mockProvider((req) => {
      if (req.path.endsWith('/api/ps')) return { json: { models: [] } };
      if (req.path.endsWith('/api/show')) return { json: {} };
      const sent = Math.round(JSON.stringify(req.body.messages).length / 4);
      return { json: reply('PELICAN', req.body.model === 'llama3.2:3b' ? 2050 : sent) };
    });
    cleanups.push(p.close);
    writeConfig([account({ id: 'ollama', provider: 'ollama', baseUrl: p.url, local: true, models: [makeModel('llama3.2:3b'), makeModel('llama3.2:1b')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([task(long, { privacy: 'secret' })]);
    expect((await engine.wait([job!.id], 10))[0]).toMatchObject({ status: 'done', accountId: 'ollama', model: 'llama3.2:1b' });
  });

  it('keeps long tasks away from that model afterwards, and still sends it short ones', async () => {
    const small = await cutting(2050);
    writeConfig([account({ id: 'ollama', provider: 'ollama', baseUrl: small.url, local: true, models: [makeModel('llama3.2:3b')] })]);
    const engine = new Engine();
    const [first] = engine.dispatch([task(long)]);
    await engine.wait([first!.id], 10);
    const longRoute = engine.preview(task(long));
    expect(longRoute.candidates).toHaveLength(0);
    expect(longRoute.rejected.map((r) => r.reason).join(' ')).toMatch(/reads only about 2,050 tokens/);
    expect(engine.preview(task('A short question.')).candidates).toHaveLength(1);
    // after a week the limit is forgotten, in case the server was given more room
    const key = contextLimitKey('ollama', 'llama3.2:3b');
    saveHealth({ [key]: { ...loadHealth()[key]!, until: Date.now() - 1 } });
    expect(new Engine().preview(task(long)).candidates).toHaveLength(1);
  });

  it('remembers the room Ollama gave the model, which is more than the part of a cut prompt it kept', async () => {
    // seen on the real server: a 4,096-token working size kept 2,050 tokens of a long prompt
    const small = await cutting(2050, 'Nothing', 4096);
    writeConfig([account({ id: 'ollama', provider: 'ollama', baseUrl: small.url, local: true, models: [makeModel('llama3.2:3b')] })]);
    const engine = new Engine();
    const [first] = engine.dispatch([task(long)]);
    await engine.wait([first!.id], 10);
    expect(loadHealth()[contextLimitKey('ollama', 'llama3.2:3b')]).toMatchObject({ contextTokens: 4096 });
    // a prompt of about 3,000 tokens fits in 4,096 and still goes there
    expect(engine.preview(task('word '.repeat(2400))).candidates).toHaveLength(1);
    expect(engine.preview(task(long)).candidates).toHaveLength(0);
  });

  it('fails with a clear reason when no model can read it all, and says how to give Ollama more room', async () => {
    const small = await cutting(2050);
    writeConfig([account({ id: 'ollama', provider: 'ollama', baseUrl: small.url, local: true, models: [makeModel('llama3.2:3b')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([task(long, { privacy: 'secret' })]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(done!.result).toBeUndefined();
    expect(done!.error).toMatch(/OLLAMA_CONTEXT_LENGTH/);
  });

  it('does not mistake a normal answer for a cut one', async () => {
    // tokens are counted differently from characters, so a short prompt or a modest difference is normal
    // a server that reads it all but counts 60% of the character estimate, as some tokenizers do
    const p = await mockProvider((req) => ({ json: chatReply('fine', { prompt_tokens: Math.round((JSON.stringify(req.body.messages).length / 4) * 0.6), completion_tokens: 2 }) }));
    cleanups.push(p.close);
    writeConfig([account({ id: 'a', baseUrl: p.url, local: true })]);
    const engine = new Engine();
    const medium = 'word '.repeat(2400);
    const [a, b] = engine.dispatch([task('A short question.'), task(medium)]);
    const done = await engine.wait([a!.id, b!.id], 10);
    expect(done.map((j) => j.status)).toEqual(['done', 'done']);
    // a short prompt counted far lower, or a count of 0, says nothing about a cut
    const low = await mockProvider((req) => ({ json: chatReply('fine', { prompt_tokens: JSON.stringify(req.body.messages).length > 20_000 ? 0 : 5, completion_tokens: 2 }) }));
    cleanups.push(low.close);
    writeConfig([account({ id: 'low', baseUrl: low.url, local: true })]);
    const counted = new Engine();
    const [d, e] = counted.dispatch([task('A short question.'), task(long)]);
    expect((await counted.wait([d!.id, e!.id], 10)).map((j) => j.status)).toEqual(['done', 'done']);
    // and a provider that reports no token count at all is trusted
    const q = await mockProvider(() => ({ json: chatReply('fine', null as never) }));
    cleanups.push(q.close);
    writeConfig([account({ id: 'b', baseUrl: q.url, local: true })]);
    const quiet = new Engine();
    const [c] = quiet.dispatch([task(long)]);
    expect((await quiet.wait([c!.id], 10))[0]!.status).toBe('done');
  });
});
