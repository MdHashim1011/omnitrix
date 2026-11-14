import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { files } from '../src/store.js';
import { account, tempHome, writeConfig } from './helpers.js';

beforeEach(() => {
  tempHome();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a server that runs for weeks', () => {
  it('trims old usage records every hour, not only when it starts', async () => {
    writeConfig([account({ id: 'a' })]);
    new Engine();
    // six megabytes of records from two months ago, written after the server started
    const old = JSON.stringify({ ts: Date.now() - 60 * 24 * 3600_000, accountId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, ok: true, latencyMs: 1 });
    fs.writeFileSync(files.ledger(), `${old}\n`.repeat(Math.ceil(6_000_000 / old.length)));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    await vi.waitFor(() => expect(fs.existsSync(files.ledger()) ? fs.statSync(files.ledger()).size : 0).toBeLessThan(1000), { timeout: 5000, interval: 200 });
  });
});
