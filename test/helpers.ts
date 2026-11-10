import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeModel } from '../src/models.js';
import { defaultSettings, saveConfig } from '../src/store.js';
import type { Account, Config } from '../src/types.js';

export function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-test-'));
  process.env.OMNITRIX_HOME = dir;
  return dir;
}

export function account(over: Partial<Account> & { id: string }): Account {
  return {
    label: over.id,
    owner: 'me',
    provider: 'custom-openai',
    driver: 'openai',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: [makeModel('test-model')],
    limits: {},
    concurrency: 2,
    enabled: true,
    trainsOnData: false,
    local: false,
    priority: 0,
    addedAt: new Date().toISOString(),
    ...over,
  };
}

export function writeConfig(accounts: Account[], settings: Partial<Config['settings']> = {}): Config {
  const cfg: Config = { version: 1, accounts, settings: { ...defaultSettings, ...settings } };
  saveConfig(cfg);
  return cfg;
}

export interface MockCall {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** A tiny fake provider. `reply` decides the status, headers and JSON body for each call. */
export async function mockProvider(reply: (call: MockCall, n: number) => { status?: number; headers?: Record<string, string>; json: unknown; delayMs?: number }) {
  const calls: MockCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const call = { path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      calls.push(call);
      const r = reply(call, calls.length);
      setTimeout(() => {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.json));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    root: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function chatReply(text: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage };
}
