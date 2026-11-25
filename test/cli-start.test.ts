import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_TOOLS, cliStartLimitMs, forgetCodexFeatures } from '../src/drivers/cli.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

// Seen in real use: a Codex run printed nothing and was still running after five minutes, so its job would
// have waited for the whole 15-minute limit. A healthy Codex reports that it started within a few seconds.

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
  forgetCodexFeatures();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A fake codex that waits `silentMs` before printing anything, then answers after `thinkMs` more. */
function fakeCodex(silentMs: number, thinkMs = 0): void {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-start-'));
  const script = path.join(bin, 'fake-codex.js');
  fs.writeFileSync(script, `const fs=require('fs');const args=process.argv.slice(2);
if(args[0]==='features')process.exit(0);
process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{
  console.log(JSON.stringify({type:'thread.started'}));
  setTimeout(()=>{
    fs.writeFileSync(args[args.indexOf('-o')+1],'fine');
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  },${thinkMs});
},${silentMs}));`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\nnode "${script}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  cleanups.push(() => {
    process.env.PATH = oldPath;
    try {
      fs.rmSync(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows may still hold the folder; nothing depends on it */
    }
  });
}

function startLimit(sec: string): void {
  const saved = process.env.OMNITRIX_CLI_START_SEC;
  process.env.OMNITRIX_CLI_START_SEC = sec;
  cleanups.push(() => {
    if (saved === undefined) delete process.env.OMNITRIX_CLI_START_SEC;
    else process.env.OMNITRIX_CLI_START_SEC = saved;
  });
}

const codex = () => account({ id: 'cx', provider: 'codex', driver: 'cli', local: true, priority: 0, models: [makeModel('default')], profileDir: path.join(home, 'profiles', 'cx') });

describe('an agent CLI that does not start', () => {
  it('waits two minutes by default, only for Codex, and the limit can be changed', () => {
    expect(cliStartLimitMs(CLI_TOOLS.codex!)).toBe(120_000);
    // other CLIs print their answer only at the end, so silence says nothing about them
    expect(cliStartLimitMs(CLI_TOOLS.gemini!)).toBeUndefined();
    startLimit('30');
    expect(cliStartLimitMs(CLI_TOOLS.codex!)).toBe(30_000);
    for (const bad of ['nonsense', '0', '-5']) {
      startLimit(bad);
      expect(cliStartLimitMs(CLI_TOOLS.codex!)).toBe(120_000);
    }
  });

  it('is stopped when it prints nothing in time, and another account gets the task', async () => {
    startLimit('1');
    fakeCodex(30_000);
    const p = await mockProvider(() => ({ json: chatReply('from the API') }));
    cleanups.push(p.close);
    writeConfig([codex(), account({ id: 'api', baseUrl: p.url, local: true, priority: 9, models: [makeModel('small:1b')] })]);
    const engine = new Engine();
    const started = Date.now();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p' }]);
    const [done] = await engine.wait([job!.id], 20);
    expect(done).toMatchObject({ status: 'done', accountId: 'api' });
    expect(done!.attempts[0]).toMatchObject({ accountId: 'cx', errorKind: 'timeout' });
    expect(done!.attempts[0]!.error).toMatch(/printed nothing in 1 s/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('may think in silence for longer once it has started', async () => {
    startLimit('1');
    fakeCodex(0, 2500);
    writeConfig([codex()]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p' }]);
    expect((await engine.wait([job!.id], 20))[0]).toMatchObject({ status: 'done', accountId: 'cx' });
  }, 30_000);
});
