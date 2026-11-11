import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverRequest } from '../src/types.js';
import { account, tempHome, writeConfig } from './helpers.js';

// capture what the engine hands to the driver instead of calling a provider
const seen: DriverRequest[] = [];
vi.mock('../src/drivers/index.js', () => ({
  runDriver: async (req: DriverRequest) => {
    seen.push(req);
    return { text: 'ok', inputTokens: 1, outputTokens: 1 };
  },
}));

const { Engine, requestTimeoutMs } = await import('../src/engine.js');

beforeEach(() => {
  tempHome();
  seen.length = 0;
});

describe('request time limits', () => {
  it('gives an API call a limit that grows with the answer size, never above the job limit', () => {
    expect(requestTimeoutMs('openai', 'small', 900)).toBe(120_000);
    expect(requestTimeoutMs('openai', undefined, 900)).toBe(300_000);
    expect(requestTimeoutMs('anthropic', 'large', 900)).toBe(600_000);
    expect(requestTimeoutMs('openai', 'large', 60)).toBe(60_000);
  });

  it('lets agent CLIs use the whole job limit', () => {
    expect(requestTimeoutMs('cli', 'small', 900)).toBe(900_000);
  });

  it('passes the limit to the driver', async () => {
    writeConfig([account({ id: 'a', local: true })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q', size: 'small' }]);
    await engine.wait([job!.id], 5);
    expect(seen[0]!.timeoutMs).toBe(120_000);
  });
});
