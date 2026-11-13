import { describe, expect, it } from 'vitest';
import { budgetFor, estimateCost, fingerprint, parseTeam, teamAccounts } from '../src/team.js';
import { makeModel } from '../src/models.js';

const valid = {
  version: 1,
  name: 'Acme',
  accounts: [
    { id: 'acme-openai', provider: 'openai', keyEnv: 'ACME_OPENAI_KEY', models: ['gpt-5.2', 'gpt-5.2-mini'], usdPerDay: 40 },
    { id: 'acme-deepseek', provider: 'deepseek', keyEnv: 'ACME_DEEPSEEK_KEY', models: ['deepseek-v4-pro'] },
  ],
  prices: { 'gpt-5.2': { input: 1.25, output: 10 }, 'deepseek-v4-pro': { input: 0.27, output: 1.1 } },
  budgets: { usdPerDay: 5, usdPerMonth: 60, people: { 'lead@acme.com': { usdPerDay: 20 } } },
};
const text = (over: Record<string, unknown> = {}) => JSON.stringify({ ...valid, ...over });

describe('team file', () => {
  it('accepts a valid file and turns its accounts into shared API accounts', () => {
    const team = parseTeam(text());
    const accounts = teamAccounts(team);
    expect(accounts.map((a) => a.id)).toEqual(['acme-openai', 'acme-deepseek']);
    const openai = accounts[0]!;
    expect(openai).toMatchObject({ team: true, owner: 'Acme', provider: 'openai', driver: 'openai', apiKey: 'env:ACME_OPENAI_KEY', baseUrl: 'https://api.openai.com/v1', local: false });
    // the team's prices go onto its models, so costs can be estimated when the provider does not report them
    expect(openai.models.find((m) => m.id === 'gpt-5.2')).toMatchObject({ inputPrice: 1.25, outputPrice: 10 });
  });

  it('refuses personal subscriptions, local models and anything that looks like a key', () => {
    const bad = (account: Record<string, unknown>) => () => parseTeam(text({ accounts: [{ id: 'x', keyEnv: 'K', models: ['m'], ...account }] }));
    expect(bad({ provider: 'codex' })).toThrow(/subscription/);
    expect(bad({ provider: 'claude-code' })).toThrow(/subscription/);
    expect(bad({ provider: 'ollama' })).toThrow(/local/);
    expect(bad({ provider: 'openai', apiKey: 'sk-live-123456789' })).toThrow(/never/);
    expect(bad({ provider: 'openai', key: 'abc' })).toThrow(/never/);
    expect(bad({ provider: 'nope' })).toThrow(/unknown provider/);
  });

  it('checks every field strictly', () => {
    const acc = valid.accounts[0]!;
    const one = (patch: Record<string, unknown>) => () => parseTeam(text({ accounts: [{ ...acc, ...patch }] }));
    expect(one({ keyEnv: 'lower-case' })).toThrow(/keyEnv/);
    expect(one({ keyEnv: undefined })).toThrow(/keyEnv/);
    expect(one({ baseUrl: 'http://api.example.com/v1' })).toThrow(/https/);
    expect(one({ models: [] })).toThrow(/models/);
    expect(one({ id: 'Bad Id!' })).toThrow(/id/);
    expect(one({ usdPerDay: -1 })).toThrow(/usdPerDay/);
    expect(() => parseTeam(text({ accounts: [acc, acc] }))).toThrow(/twice/);
    expect(() => parseTeam(text({ version: 2 }))).toThrow(/version/);
    expect(() => parseTeam(text({ auditDir: 'relative/path' }))).toThrow(/absolute/);
    expect(() => parseTeam('{ not json')).toThrow(/JSON/);
  });

  it('fingerprints the exact contents, so any change is noticed', () => {
    expect(fingerprint(text())).toBe(fingerprint(text()));
    expect(fingerprint(text())).not.toBe(fingerprint(text({ name: 'Acme2' })));
  });

  it('gives each person the team budget unless the file sets their own', () => {
    const team = parseTeam(text());
    expect(budgetFor(team, 'dev@acme.com')).toEqual({ day: 5, month: 60 });
    expect(budgetFor(team, 'lead@acme.com')).toEqual({ day: 20, month: 60 });
    expect(budgetFor(parseTeam(text({ budgets: undefined })), 'dev@acme.com')).toEqual({});
  });

  it('estimates cost from prices per million tokens, and only when a price is known', () => {
    expect(estimateCost(makeModel('gpt-5.2', { inputPrice: 1.25, outputPrice: 10 }), 200_000, 10_000)).toBeCloseTo(0.35, 6);
    expect(estimateCost(makeModel('free-model'), 200_000, 10_000)).toBeUndefined();
    expect(estimateCost(undefined, 1, 1)).toBeUndefined();
  });
});
