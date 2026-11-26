import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAGE } from '../src/dashboard.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { setSecret } from '../src/store.js';
import type { UsageRecord } from '../src/types.js';
import { readLedger, summarize } from '../src/usage.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// Every figure on an account card must be true and say where it comes from: the provider's own reading, or
// omnitrix's count on this PC against a limit set by hand. Nothing estimated may look measured.

const now = Date.UTC(2026, 10, 26, 12);
const rec = (extra: Partial<UsageRecord>): UsageRecord => ({ ts: now - 60_000, accountId: 'acc', model: 'm', inputTokens: 100, outputTokens: 50, ok: true, latencyMs: 900, ...extra });
const plan = { at: now - 2 * 60_000, plan: 'plus', windows: [{ name: '5 hours', minutes: 300, usedPercent: 40, resetsAt: now + 3600_000 }] };

describe('where each limit figure comes from', () => {
  it('marks a counted window as counted and a provider window as the provider reading, with its time', () => {
    const acc = account({ id: 'acc', limits: { requestsPerDay: 100 } });
    const s = summarize(acc, [rec({})], undefined, now, plan);
    expect(s.windows.map((w) => [w.name, w.source, w.readAt])).toEqual([['24 hours', 'counted', undefined], ['5 hours', 'provider', plan.at]]);
  });

  it('does not call counted bars measured because a rate-limit header was read', () => {
    const acc = account({ id: 'acc', limits: { requestsPerDay: 100 } });
    const health = { state: 'ready' as const, measured: { remainingRequests: 59, at: now - 1000, source: 'response headers' } };
    expect(summarize(acc, [rec({})], health, now).source).toBe('estimated');
    // with no bars at all, the header reading is still the provider's own number
    expect(summarize(account({ id: 'acc' }), [], health, now).source).toBe('measured');
  });

  it('counts answers that reported no tokens instead of showing them as zero tokens', () => {
    const s = summarize(account({ id: 'acc' }), [rec({}), rec({ inputTokens: 0, outputTokens: 0 }), rec({ ok: false, inputTokens: 0, outputTokens: 0, errorKind: 'server' })], undefined, now);
    expect([s.requestsToday, s.tokensToday, s.untokenedToday]).toEqual([2, 150, 1]);
  });

  it('says when part of the cost is an estimate from prices', () => {
    expect(summarize(account({ id: 'acc' }), [rec({ costUsd: 0.01 })], undefined, now).costEstimated).toBeUndefined();
    expect(summarize(account({ id: 'acc' }), [rec({ costUsd: 0.01 }), rec({ costUsd: 0.02, costEstimated: true })], undefined, now).costEstimated).toBe(true);
  });
});

describe('a cost the provider did not report', () => {
  let close: (() => Promise<void>) | undefined;
  beforeEach(() => {
    tempHome();
  });
  afterEach(async () => {
    await close?.();
  });

  it('is recorded as estimated from the price, and a reported one is not', async () => {
    const provider = await mockProvider((call) => ({ json: call.body.messages.at(-1).content.includes('billed') ? { ...chatReply('ok'), usage: { prompt_tokens: 1000, completion_tokens: 1000, cost: 0.5 } } : chatReply('ok', { prompt_tokens: 1000, completion_tokens: 1000 }) }));
    close = provider.close;
    setSecret('priced', 'sk-test-priced-000000000');
    writeConfig([account({ id: 'priced', baseUrl: provider.url, apiKey: 'secret', models: [makeModel('m', { inputPrice: 1, outputPrice: 2 })] })]);
    const engine = new Engine();
    const jobs = engine.dispatch([{ title: 'a', type: 'writing', prompt: 'plain', privacy: 'public' }]);
    await engine.wait(jobs.map((j) => j.id), 10);
    const [r] = readLedger().filter((x) => x.ok);
    expect(r!.costUsd).toBeCloseTo(0.003, 6);
    expect(r!.costEstimated).toBe(true);
  });
});

// The page's own functions, cut out of the page the dashboard serves, so the test checks the code a browser runs.
function cut(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name} in the page`);
  let depth = 0;
  for (let i = PAGE.indexOf('{', start); i < PAGE.length; i++) {
    if (PAGE[i] === '{') depth++;
    else if (PAGE[i] === '}' && --depth === 0) return PAGE.slice(start, i + 1);
  }
  throw new Error(`function ${name} does not end`);
}
const line = (re: RegExp) => PAGE.match(re)![0];
const vars = ['esc', 'fmt', 'money', 'about', 'clock', 'span', 'ago'].map((n) => line(new RegExp(`var ${n}=function[^\\n]*`)));
const consts = ['STATES', 'SOURCES', 'GRIP', 'DOTS'].map((n) => line(new RegExp(`var ${n}=[^\\n]*`)));
const page = new Function(`${vars.join('\n')}\n${consts.join('\n')}\n${['icon', 'sourceOf', 'leftOf', 'windowHtml', 'cardHtml'].map(cut).join('\n')}\nreturn { cardHtml };`)() as {
  cardHtml: (a: Record<string, unknown>, open: Record<string, boolean>, movable: boolean) => string;
};
const base = { windows: [], source: 'untracked', requestsToday: 3, failedToday: 0, tokensToday: 900, untokenedToday: 0, costToday: 0 };
const card = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  page.cardHtml({ id: 'a', label: 'A', state: 'ready', driver: 'openai', models: ['m'], usage: { ...base, ...usage }, ...extra }, {}, false);
const counted = { name: '24 hours', unit: 'requests', used: 3, limit: 100, remaining: 97, source: 'counted' };
const provider = { name: '5 hours', unit: 'percent', used: 40, limit: 100, remaining: 60, source: 'provider', readAt: Date.now() - 120_000 };

describe('the figures on an account card', () => {
  it('names one source under the bars when they share it', () => {
    expect(card({ windows: [counted] })).toContain('<span class="prov">Counted by omnitrix on this PC against the limits you set</span>');
    expect(card({ windows: [provider] })).toContain('<span class="prov">Read from the provider, 2 min ago</span>');
    // an old reading leaves out the age here; the warning below the bars gives its time
    expect(card({ windows: [provider], stale: true, updatedAt: Date.now() - 3600_000 })).toContain('<span class="prov">Read from the provider</span>');
  });

  it('names the source of each bar when the provider reading and the count are mixed', () => {
    const html = card({ windows: [counted, provider], source: 'measured' });
    expect(html).not.toContain('class="prov"');
    expect(html).toMatch(/24 hours \(requests\).*Counted by omnitrix on this PC.*5 hours.*Read from the provider, 2 min ago/s);
  });

  it('never shows zero tokens for answers whose provider gave no count', () => {
    expect(card({ untokenedToday: 3, tokensToday: 0 })).toContain('<span>tokens not reported</span>');
    expect(card({ untokenedToday: 1 })).toContain('<span><b>900</b> tokens, 1 answer without a count</span>');
    expect(card({})).toContain('<span><b>900</b> tokens</span>');
  });

  it('marks an estimated cost as an estimate', () => {
    expect(card({ costToday: 0.25, costEstimated: true })).toContain('<span title="Estimated from the prices set in omnitrix"><b>about $0.25</b></span>');
    expect(card({ costToday: 0.25 })).toContain('<span><b>$0.25</b></span>');
    // "under $0.01" already says it is not exact
    expect(card({ costToday: 0.001, costEstimated: true })).toContain('<b>under $0.01</b>');
  });

  it("shows what the provider's last reply said is left when it gave no limit to draw", () => {
    const html = card({ measured: { remainingRequests: 59, remainingTokens: 14200, at: Date.now() - 60_000, source: 'response headers' } });
    expect(html).toContain("The provider&#39;s last reply, 1 min ago, said 59 requests and 14.2k tokens left.");
    // so the card does not also say that nothing is known
    expect(html).not.toContain('No limit is known');
    expect(card({})).toContain('No limit is known');
    // a provider bar already shows the provider's own numbers
    expect(card({ windows: [provider], measured: { remainingRequests: 59, at: Date.now(), source: 'response headers' } })).not.toContain('last reply');
  });

  it('does not say a plan publishes no limits when its last reading has only passed its reset', () => {
    const html = card({ updatedAt: Date.now() - 3600_000 }, { driver: 'cli' });
    expect(html).toContain('has passed its reset time. omnitrix reads them again when the account is next used.');
    expect(html).not.toContain('does not publish its limits');
    expect(card({}, { driver: 'cli' })).toContain('does not publish its limits');
  });
});
