import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localModels } from '../src/drivers/ollama.js';
import { runOpenAI } from '../src/drivers/openai.js';
import { buildPrompt, taskImages } from '../src/engine.js';
import { makeModel, rateModel, statsKey } from '../src/models.js';
import { route } from '../src/router.js';
import { defaultSettings, setSecret } from '../src/store.js';
import { account, chatReply, mockProvider, tempHome } from './helpers.js';

const cleanups: (() => unknown)[] = [];
beforeEach(() => {
  tempHome();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('scores for local models', () => {
  it('do not rise because a word in the name matches a famous model', () => {
    const fable = rateModel('local-defiant-fable-9b', { local: true });
    const plain = rateModel('local-defiant-xyz-9b', { local: true });
    expect(fable.skills).toEqual(plain.skills);
    expect(fable.skills.coding).toBeLessThan(9);
  });

  it('give an unknown local model neutral scores, marked untested', () => {
    const r = rateModel('my-model', { local: true });
    expect(r.basis).toBe('untested');
    expect(r.skills).toMatchObject({ coding: 6, reasoning: 6, writing: 6, longContext: 6, vision: 0 });
  });

  it('give vision only when the server reports it', () => {
    expect(rateModel('qwen2.5vl:3b', { local: true, capabilities: ['completion', 'vision'] }).skills.vision).toBeGreaterThanOrEqual(5);
    expect(rateModel('qwen2.5vl:3b', { local: true, capabilities: ['completion'] }).skills.vision).toBe(0);
    // without metadata a name alone never claims vision on a local model
    expect(rateModel('llava-custom', { local: true }).skills.vision).toBe(0);
    expect(rateModel('gpt-oss:20b', { local: true, capabilities: ['completion', 'tools'] }).skills.vision).toBe(0);
  });

  it('use the parameter count the server reports instead of the name', () => {
    expect(rateModel('mystery', { local: true, parameterSize: '3.2B' }).skills.coding).toBeLessThan(5);
    expect(rateModel('mystery', { local: true, parameterSize: '3.2B' }).basis).toBe('estimated');
  });
});

describe('scores for hosted models', () => {
  it('say they are estimated from the name, and GPT-OSS is not given vision', () => {
    expect(rateModel('gpt-5.2').basis).toBe('estimated');
    expect(rateModel('gpt-oss-120b').skills.vision).toBe(0);
    expect(makeModel('gpt-5.2').basis).toBe('estimated');
  });
});

describe('feedback', () => {
  it('belongs to the exact model version when the server names one', () => {
    expect(statsKey(makeModel('llama3.2:latest', { digest: 'abcdef1234567890' }))).toBe('llama3.2:latest@abcdef123456');
    expect(statsKey(makeModel('gpt-5.2'))).toBe('gpt-5.2');
  });

  it('a new version under the same tag starts without the old feedback', () => {
    const old = makeModel('llama3.2:latest', { digest: 'aaaaaaaaaaaa1111' });
    const fresh = makeModel('llama3.2:latest', { digest: 'bbbbbbbbbbbb2222' });
    const acc = account({ id: 'ol', local: true, baseUrl: 'http://localhost:11434/v1', models: [fresh] });
    const stats = { [`${statsKey(old)}|writing`]: { ok: 0, bad: 9, at: Date.now() } };
    const { candidates } = route({ title: 't', type: 'writing', prompt: 'p' }, { config: { version: 1, accounts: [acc], settings: { ...defaultSettings } }, usage: {}, health: {}, running: {}, stats } as never);
    expect(candidates[0]!.why.join(' ')).not.toMatch(/past results/);
  });
});

describe('the reasons the router gives', () => {
  it('say when scores are only a guess', () => {
    const acc = account({ id: 'ol', local: true, baseUrl: 'http://localhost:11434/v1', models: [makeModel('my-model', {}, { local: true })] });
    const { candidates } = route({ title: 't', type: 'writing', prompt: 'p' }, { config: { version: 1, accounts: [acc], settings: { ...defaultSettings } }, usage: {}, health: {}, running: {}, stats: {} } as never);
    expect(candidates[0]!.why.join(' ')).toMatch(/untested/);
  });
});

describe('image tasks', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3a8f1cb0000000049454e44ae426082', 'hex');

  it('go only to accounts whose driver can send the image, to models that can read it', () => {
    const cli = account({ id: 'cx', provider: 'codex', driver: 'cli', models: [makeModel('gpt-5.2')] });
    const local = account({ id: 'ol', local: true, baseUrl: 'http://localhost:11434/v1', models: [makeModel('qwen2.5vl:3b', {}, { local: true, capabilities: ['vision'] }), makeModel('llama3.2:3b', {}, { local: true, capabilities: ['completion'] })] });
    const { candidates } = route({ title: 't', type: 'vision', prompt: 'p' }, { config: { version: 1, accounts: [cli, local], settings: { ...defaultSettings } }, usage: {}, health: {}, running: {}, stats: {} } as never);
    expect(candidates.map((c) => `${c.accountId}/${c.model}`)).toEqual(['ol/qwen2.5vl:3b']);
  });

  it('send the image itself, not its bytes as text', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-img-'));
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(file, png);
    const task = { title: 't', type: 'vision' as const, prompt: 'what is this?', files: [file] };
    const acc = account({ id: 'a' });
    const prompt = buildPrompt(task, acc, undefined);
    expect(prompt).toContain('(image, sent with the request)');
    expect(prompt).not.toContain('PNG');
    const images = taskImages(task, undefined);
    expect(images).toHaveLength(1);
    expect(images[0]!.mime).toBe('image/png');

    const p = await mockProvider(() => ({ json: chatReply('a dot') }));
    cleanups.push(p.close);
    setSecret('a', 'sk-test-123456789012345');
    await runOpenAI({ account: account({ id: 'a', baseUrl: p.url, apiKey: 'secret' }), model: 'test-model', prompt, images, timeoutMs: 5000 });
    const content = p.calls[0]!.body.messages.at(-1).content;
    expect(content[1]).toMatchObject({ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } });
  });
});

describe('Ollama metadata', () => {
  it('reads capabilities, size and version from the server', async () => {
    const s = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5vl:3b', digest: 'd1d1d1d1d1d1d1d1', details: { parameter_size: '3.8B' } }, { name: 'llama3.2:3b', digest: 'e2e2e2e2e2e2e2e2', details: { parameter_size: '3.2B' } }] }));
        const name = JSON.parse(raw || '{}').model;
        res.end(JSON.stringify({ capabilities: name === 'qwen2.5vl:3b' ? ['completion', 'vision'] : ['completion', 'tools'] }));
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => s.close(() => r(undefined))));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`;
    const models = await localModels(base, ['qwen2.5vl:3b', 'llama3.2:3b']);
    const vl = models.find((m) => m.id === 'qwen2.5vl:3b')!;
    expect(vl.skills.vision).toBeGreaterThanOrEqual(5);
    expect(vl.visionChecked).toBe(true);
    expect(vl.digest).toBe('d1d1d1d1d1d1d1d1');
    expect(models.find((m) => m.id === 'llama3.2:3b')!.skills.vision).toBe(0);
  });
});

describe('after review', () => {
  it('sends pictures only with vision tasks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-img2-'));
    const file = path.join(dir, 'shot.png');
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    const review = { title: 't', type: 'review' as const, prompt: 'p', files: [file] };
    expect(taskImages(review, undefined)).toEqual([]);
    expect(buildPrompt(review, account({ id: 'a' }), undefined)).toContain('(image, not sent: only vision tasks send pictures)');
  });

  it('does not attach a picture too large to send once encoded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-img3-'));
    const file = path.join(dir, 'big.png');
    fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024));
    expect(taskImages({ title: 't', type: 'vision', prompt: 'p', files: [file] }, undefined)).toEqual([]);
  });

  it('lets a person vouch for vision on any local server', () => {
    const m = { ...makeModel('my-vl', {}, { local: true }), pinned: true };
    m.skills.vision = 8;
    const acc = account({ id: 'lms', provider: 'lmstudio', local: true, baseUrl: 'http://localhost:1234/v1', models: [m] });
    const { candidates } = route({ title: 't', type: 'vision', prompt: 'p' }, { config: { version: 1, accounts: [acc], settings: { ...defaultSettings } }, usage: {}, health: {}, running: {}, stats: {} } as never);
    expect(candidates.map((c) => c.model)).toEqual(['my-vl']);
  });

  it('keeps counting verdicts saved before versions were recorded', () => {
    const m = makeModel('llama3.2:3b', { digest: 'abcdef1234567890' }, { local: true });
    const acc = account({ id: 'ol', local: true, baseUrl: 'http://localhost:11434/v1', models: [m] });
    const stats = { 'llama3.2:3b|writing': { ok: 5, bad: 0, at: Date.now() } };
    const { candidates } = route({ title: 't', type: 'writing', prompt: 'p' }, { config: { version: 1, accounts: [acc], settings: { ...defaultSettings } }, usage: {}, health: {}, running: {}, stats } as never);
    expect(candidates[0]!.why.join(' ')).toMatch(/past results/);
  });

  it('does not guess vision for hosted models that are text only', () => {
    for (const id of ['deepseek-flash', 'kimi-k2-turbo', 'gpt-3.5-turbo', 'grok-code-fast-1', 'gpt-5-codex']) expect(rateModel(id).skills.vision, id).toBe(0);
    expect(rateModel('gpt-5.2').skills.vision).toBeGreaterThan(0);
  });
});
