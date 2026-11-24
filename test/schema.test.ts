import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPrompt, Engine } from '../src/engine.js';
import { jobView } from '../src/mcp.js';
import { makeModel } from '../src/models.js';
import { extractJson, readStructured, schemaProblem } from '../src/schema.js';
import { setSecret } from '../src/store.js';
import type { TaskSpec } from '../src/types.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const cleanups: (() => unknown)[] = [];
beforeEach(() => {
  tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const person = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } }, required: ['name', 'age'], additionalProperties: false };
const task = (over: Partial<TaskSpec> = {}): TaskSpec => ({ title: 'extract', type: 'bulk', prompt: 'who wrote the email?', outputSchema: person, ...over });

describe('finding the JSON in an answer', () => {
  it('reads a bare value, a fenced one and one with a sentence around it', () => {
    expect(extractJson('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(extractJson('Here it is:\n```json\n{"a":2}\n```\nDone.')).toEqual({ value: { a: 2 } });
    expect(extractJson('The answer is [1, 2] as asked.')).toEqual({ value: [1, 2] });
    // the fence wins over the span from the first bracket to the last, which here holds two values
    expect(extractJson('Not {"a":0} but:\n```json\n{"a":3}\n```')).toEqual({ value: { a: 3 } });
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{"a": 1,,}')).toBeUndefined();
  });
});

describe('checking the answer against the schema', () => {
  it('says valid, lists what is wrong, or says there was no JSON', () => {
    expect(readStructured('{"name":"Ada","age":36}', person)).toEqual({ status: 'valid' });
    const bad = readStructured('{"name":3,"age":-1,"extra":true}', person);
    expect(bad.status).toBe('invalid');
    expect(bad.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^name: /), expect.stringMatching(/^age: /), expect.stringMatching(/extra/)]));
    expect(readStructured('I could not find a name.', person)).toEqual({ status: 'not_json', errors: ['the answer contains no JSON value'] });
  });

  it('refuses schemas it cannot use, before anything runs', () => {
    expect(schemaProblem(person)).toBeUndefined();
    expect(schemaProblem({ type: 'banana' })).toMatch(/banana/);
    expect(schemaProblem({ $ref: 'https://example.com/s.json' })).toMatch(/\$ref/);
    expect(schemaProblem([1])).toMatch(/object/);
    expect(schemaProblem({ type: 'object', description: 'x'.repeat(30_000) })).toMatch(/20,000/);
    writeConfig([account({ id: 'a' })]);
    const engine = new Engine();
    expect(() => engine.dispatch([task({ outputSchema: { type: 'banana' } })])).toThrow(/output_schema.*banana/);
    expect(() => engine.dispatch([task({ type: 'code', repo: process.cwd() })])).toThrow(/output_schema.*code/);
  });

  it('tells the worker the format, after the task', () => {
    const prompt = buildPrompt(task(), account({ id: 'a' }), undefined);
    expect(prompt).toMatch(/## Answer format[\s\S]*only one JSON value[\s\S]*"additionalProperties": false/);
    expect(prompt.indexOf('## Answer format')).toBeGreaterThan(prompt.indexOf('who wrote the email?'));
    expect(buildPrompt(task({ outputSchema: undefined }), account({ id: 'a' }), undefined)).not.toMatch(/Answer format/);
  });
});

describe('a job with an answer format', () => {
  async function workers(cheapAnswer: string, strongAnswer = '{"name":"Ada","age":36}') {
    const cheap = await mockProvider(() => ({ json: chatReply(cheapAnswer) }));
    const strong = await mockProvider(() => ({ json: chatReply(strongAnswer) }));
    cleanups.push(cheap.close, strong.close);
    const skills = (n: number) => ({ coding: n, reasoning: n, writing: n, longContext: n, speed: 5, vision: 0 });
    writeConfig([
      account({ id: 'cheap', baseUrl: cheap.url, local: true, models: [makeModel('small', { skills: skills(8) })] }),
      account({ id: 'strong', baseUrl: strong.url, apiKey: 'secret', models: [{ ...makeModel('big', { skills: skills(9) }), inputPrice: 3, outputPrice: 15 }] }),
    ]);
    setSecret('strong', 'sk-test-123456789012345');
    return { cheap, strong };
  }

  it('gives Claude the parsed value of a valid answer', async () => {
    await workers('```json\n{"name":"Ada","age":36}\n```');
    const engine = new Engine();
    const [job] = engine.dispatch([task({ use: 'cheap' })]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.structured).toEqual({ status: 'valid' });
    expect(jobView(done!, false, engine).structured).toEqual({ status: 'valid', value: { name: 'Ada', age: 36 } });
  });

  it('lists the problems of an invalid answer, and leaves a large value to the full view', async () => {
    await workers('{"name":3}');
    const engine = new Engine();
    const [job] = engine.dispatch([task({ use: 'cheap' })]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.structured!.status).toBe('invalid');
    expect(jobView(done!, false, engine).structured).toMatchObject({ status: 'invalid', errors: expect.arrayContaining([expect.stringMatching(/^name: /)]) });
    expect(done!.escalatedTo).toBeUndefined();

    const big = { name: 'x'.repeat(5_000), age: 1 };
    await workers(JSON.stringify(big));
    const e2 = new Engine();
    const [j2] = e2.dispatch([task({ use: 'cheap' })]);
    const [d2] = await e2.wait([j2!.id], 10);
    expect(jobView(d2!, false, e2).structured).toEqual({ status: 'valid', note: expect.stringMatching(/full/) });
    expect(jobView(d2!, true, e2).structured).toEqual({ status: 'valid', value: big });
  });

  it('with escalate, sends an answer in the wrong format to a stronger model', async () => {
    await workers('Ada, 36');
    const engine = new Engine();
    const [job] = engine.dispatch([task({ escalate: true })]);
    const [done] = await engine.wait([job!.id], 20);
    expect(done).toMatchObject({ accountId: 'cheap', structured: { status: 'not_json' } });
    const second = engine.getJob(done!.escalatedTo!)!;
    expect(second).toMatchObject({ accountId: 'strong', structured: { status: 'valid' } });
    expect(second.task.prompt).toMatch(/did not pass[\s\S]*JSON/);
  }, 30_000);
});
