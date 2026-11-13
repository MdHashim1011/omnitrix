import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');

describe('MCP server (real stdio process)', () => {
  let client: Client;
  let provider: Awaited<ReturnType<typeof mockProvider>>;

  beforeAll(async () => {
    if (!fs.existsSync(cli)) throw new Error('run the build first (dist/cli.js missing)');
    const home = tempHome();
    provider = await mockProvider(() => ({ json: chatReply('# Plan\n1. do it') }));
    writeConfig([account({ id: 'worker', label: 'Test worker', baseUrl: provider.url, local: true, limits: { requestsPerDay: 100 } })]);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...(process.env as Record<string, string>), OMNITRIX_HOME: home }, stderr: 'pipe' }));
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await provider?.close();
  });

  it('lists the tools and gives instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cancel_job', 'dispatch', 'get_results', 'list_jobs', 'pool_status', 'rate_result', 'read_output', 'route_preview']);
  });

  it('shows the pool, runs a task and learns from the verdict', async () => {
    const status: any = await client.callTool({ name: 'pool_status', arguments: {} });
    expect(status.content[0].text).toMatch(/1\/1 accounts available/);
    expect(status.content[0].text).toMatch(/100\/100 requests left/);

    const preview: any = await client.callTool({ name: 'route_preview', arguments: { tasks: [{ title: 'plan', type: 'reasoning', prompt: 'make a plan' }] } });
    expect(preview.content[0].text).toMatch(/worker\/test-model/);

    const sent: any = await client.callTool({ name: 'dispatch', arguments: { tasks: [{ title: 'plan', type: 'reasoning', prompt: 'make a plan', acceptance: 'has steps' }] } });
    const ids = sent.structuredContent.job_ids as string[];
    expect(ids).toHaveLength(1);

    const res: any = await client.callTool({ name: 'get_results', arguments: { job_ids: ids, wait_seconds: 10 } });
    const job = res.structuredContent.jobs[0];
    expect(job.status).toBe('done');
    expect(job.result).toMatch(/# Plan/);

    const rated: any = await client.callTool({ name: 'rate_result', arguments: { job_id: ids[0], accepted: true } });
    expect(rated.content[0].text).toMatch(/accepted/);

    const after: any = await client.callTool({ name: 'pool_status', arguments: {} });
    expect(after.content[0].text).toMatch(/99\/100 requests left/);
    expect(provider.calls[0]!.body.messages[1].content).toMatch(/## Done means\nhas steps/);
  });

  it('rejects code tasks without a repo', async () => {
    const r: any = await client.callTool({ name: 'dispatch', arguments: { tasks: [{ title: 'x', type: 'code', prompt: 'p' }] } });
    expect(r.isError).toBe(true);
  });

  // Some clients show only structuredContent, so it must carry everything the text does.
  it('declares output schemas and puts the full pool in structured data', async () => {
    const { tools } = await client.listTools();
    for (const name of ['pool_status', 'dispatch', 'get_results']) expect(tools.find((t) => t.name === name)!.outputSchema, name).toBeDefined();
    const status: any = await client.callTool({ name: 'pool_status', arguments: {} });
    expect(status.structuredContent).toMatchObject({ ready: 1, total: 1 });
    expect(status.structuredContent.accounts[0]).toMatchObject({ id: 'worker', label: 'Test worker', models: ['test-model'], quota: [expect.stringMatching(/requests left/)] });
    expect(status.structuredContent.accounts[0]).toMatchObject({ requestsToday: expect.any(Number), costToday: expect.any(Number), remainingRequests: null });
    // numbers a widget can draw from, not just the text line
    expect(status.structuredContent.accounts[0].windows).toContainEqual({ name: '24 hours', unit: 'requests', used: expect.any(Number), limit: 100, remaining: expect.any(Number), resetsAt: null, runsOutAt: null });
    expect(status.structuredContent.accounts[0].pausedModels).toEqual([]);
  });

  it('tells a job that failed at dispatch from a queued one in structured data', async () => {
    const sent: any = await client.callTool({ name: 'dispatch', arguments: { tasks: [{ title: 'secret', type: 'writing', prompt: 'p', privacy: 'secret', use: 'nobody' }] } });
    expect(sent.structuredContent.jobs[0]).toMatchObject({ title: 'secret', status: 'failed', error: expect.stringMatching(/no account/) });
  });

  it('reports unknown and pending job ids as data', async () => {
    const res: any = await client.callTool({ name: 'get_results', arguments: { job_ids: ['nope'], wait_seconds: 0 } });
    expect(res.structuredContent).toEqual({ jobs: [], pending: 0, unknown: ['nope'] });
  });

  it('keeps the note given with a verdict', async () => {
    const sent: any = await client.callTool({ name: 'dispatch', arguments: { tasks: [{ title: 'n', type: 'writing', prompt: 'p' }] } });
    const id = sent.structuredContent.job_ids[0];
    await client.callTool({ name: 'get_results', arguments: { job_ids: [id], wait_seconds: 10 } });
    await client.callTool({ name: 'rate_result', arguments: { job_id: id, accepted: false, note: 'missed the second step' } });
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.OMNITRIX_HOME!, 'jobs', `${id}.json`), 'utf8'));
    expect(saved).toMatchObject({ verdict: 'rejected', verdictNote: 'missed the second step' });
  });
});

describe('MCP server with no accounts', () => {
  it('still returns structured data that matches its schema', async () => {
    const home = tempHome();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...(process.env as Record<string, string>), OMNITRIX_HOME: home }, stderr: 'pipe' }));
    try {
      const status: any = await client.callTool({ name: 'pool_status', arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent).toEqual({ ready: 0, total: 0, accounts: [] });
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('MCP server with a forecast', () => {
  it('reports when a window runs out, in both text and numbers', async () => {
    const home = tempHome();
    writeConfig([account({ id: 'worker', limits: { requestsPerDay: 100 } })]);
    const now = Date.now();
    const hour = 3600_000;
    // 2 hours into a 5-hour window with 60% used: at that pace the rest lasts about 80 minutes
    fs.writeFileSync(path.join(home, 'quota.json'), JSON.stringify({ worker: { at: now, windows: [{ name: '5 hours', minutes: 300, usedPercent: 60, resetsAt: now + 3 * hour }] } }));
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...(process.env as Record<string, string>), OMNITRIX_HOME: home }, stderr: 'pipe' }));
    try {
      const status: any = await client.callTool({ name: 'pool_status', arguments: {} });
      expect(status.isError).toBeFalsy();
      const windows = status.structuredContent.accounts[0].windows;
      const plan = windows.find((w: any) => w.unit === 'percent');
      expect(plan.runsOutAt).toBeGreaterThan(now + 75 * 60_000);
      expect(plan.runsOutAt).toBeLessThan(plan.resetsAt);
      expect(windows.find((w: any) => w.unit === 'requests').runsOutAt).toBeNull();
      expect(status.structuredContent.accounts[0].quota.join(' ')).toMatch(/runs out in about 1 h (19|20) min at this pace/);
      expect(status.content[0].text).toMatch(/runs out in about 1 h (19|20) min at this pace/);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('MCP retry after a rejection', () => {
  it('sends the task to another model and returns the new job id', async () => {
    const home = tempHome();
    const first = await mockProvider(() => ({ json: chatReply('first answer') }));
    const second = await mockProvider(() => ({ json: chatReply('second answer') }));
    writeConfig([account({ id: 'first', baseUrl: first.url, local: true, priority: 0 }), account({ id: 'second', baseUrl: second.url, local: true, priority: 1 })]);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...(process.env as Record<string, string>), OMNITRIX_HOME: home }, stderr: 'pipe' }));
    try {
      const sent: any = await client.callTool({ name: 'dispatch', arguments: { tasks: [{ title: 'summary', type: 'writing', prompt: 'write the summary' }] } });
      const id = sent.structuredContent.job_ids[0];
      await client.callTool({ name: 'get_results', arguments: { job_ids: [id], wait_seconds: 10 } });
      // a retry without a reason is refused: the next worker needs to know what was wrong
      const bare: any = await client.callTool({ name: 'rate_result', arguments: { job_id: id, accepted: false, retry: true } });
      expect(bare.isError).toBe(true);
      const r: any = await client.callTool({ name: 'rate_result', arguments: { job_id: id, accepted: false, note: 'the deadline is missing', retry: true } });
      expect(r.isError).toBeFalsy();
      const newId = /retry: (\S+)/.exec(r.content[0].text)![1];
      const res: any = await client.callTool({ name: 'get_results', arguments: { job_ids: [newId], wait_seconds: 10 } });
      expect(res.structuredContent.jobs[0]).toMatchObject({ status: 'done', account: 'second' });
      expect(JSON.stringify(second.calls[0]!.body.messages)).toContain('the deadline is missing');
    } finally {
      await client.close();
      await first.close();
      await second.close();
    }
  }, 30_000);
});

describe('MCP second-model check', () => {
  it('waits for the check and shows its verdict with the result', async () => {
    const home = tempHome();
    const worker = await mockProvider(() => ({ json: chatReply('The report is due on Friday.'), delayMs: 100 }));
    const checker = await mockProvider(() => ({ json: chatReply('PASS\nIt states the Friday deadline.'), delayMs: 300 }));
    writeConfig([account({ id: 'worker', baseUrl: worker.url, local: true, priority: 0 }), account({ id: 'checker', baseUrl: checker.url, local: true, priority: 1 })]);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], env: { ...(process.env as Record<string, string>), OMNITRIX_HOME: home }, stderr: 'pipe' }));
    try {
      const noLine: any = await client.callTool({ name: 'dispatch', arguments: { tasks: [{ title: 's', type: 'writing', prompt: 'summarise', check: true }] } });
      expect(noLine.isError).toBe(true);
      const sent: any = await client.callTool({ name: 'dispatch', arguments: { tasks: [{ title: 'summary', type: 'writing', prompt: 'summarise the email', acceptance: 'mentions the deadline', check: true }] } });
      const id = sent.structuredContent.job_ids[0];
      const res: any = await client.callTool({ name: 'get_results', arguments: { job_ids: [id], wait_seconds: 10 } });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.pending).toBe(0);
      expect(res.structuredContent.jobs[0]).toMatchObject({ status: 'done', account: 'worker', check: { status: 'pass', by: 'checker/test-model', note: 'It states the Friday deadline.' } });
    } finally {
      await client.close();
      await worker.close();
      await checker.close();
    }
  }, 30_000);
});
