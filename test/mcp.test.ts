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
});
