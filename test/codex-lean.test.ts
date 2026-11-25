import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_TOOLS, forgetCodexFeatures, leanFeatures, readFeatureList } from '../src/drivers/cli.js';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { account, tempHome, writeConfig } from './helpers.js';

// Every Codex request carried the tools of features that a worker never uses, such as browser and computer
// use, apps and image generation: about 25,000 input tokens for a one-word answer, against about 13,800 with
// them turned off (measured with codex-cli 0.167.1).

const cleanups: (() => unknown)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
  forgetCodexFeatures();
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const LIST = `apps                                     stable             true
browser_use                              stable             true
computer_use                             stable             true
image_generation                         stable             true
shell_tool                               stable             true
view_image                               stable             true
worktrees                                removed            true
goals                                    stable             false
`;

describe('the features Codex lists', () => {
  it('are read from its table, without removed ones', () => {
    expect([...readFeatureList(LIST)].sort()).toEqual(['apps', 'browser_use', 'computer_use', 'goals', 'image_generation', 'shell_tool', 'view_image']);
    expect(readFeatureList('Error: something broke\n').size).toBe(0);
  });

  it('turn off only the extras this Codex knows, never the shell or pictures', () => {
    const off = leanFeatures(readFeatureList(LIST));
    expect(off).toEqual(expect.arrayContaining(['apps', 'browser_use', 'computer_use', 'image_generation', 'goals']));
    expect(off).not.toContain('shell_tool');
    expect(off).not.toContain('view_image');
    expect(off).not.toContain('plugins');
    expect(leanFeatures(new Set())).toEqual([]);
  });

  it('go to Codex as config settings, which an unknown name cannot break', () => {
    const args = CLI_TOOLS.codex!.args({ model: 'default', edit: false, cwd: '.', outFile: 'o.txt', off: ['apps', 'computer_use'] });
    expect(args.join(' ')).toContain('-c features.apps=false -c features.computer_use=false');
    expect(CLI_TOOLS.codex!.args({ model: 'default', edit: false, cwd: '.', outFile: 'o.txt' }).join(' ')).not.toContain('features.');
  });
});

describe('a Codex job', () => {
  function fakeCodex(featureExit = 0): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-lean-'));
    const script = path.join(bin, 'fake-codex.js');
    const log = path.join(bin, 'args.log');
    fs.writeFileSync(script, `const fs=require('fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='features'){process.stdout.write(${JSON.stringify(LIST)});process.exit(${featureExit});}
process.stdin.resume();process.stdin.on('end',()=>{
  fs.writeFileSync(args[args.indexOf('-o')+1],'fine');
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
});`);
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
    return log;
  }
  const runs = (log: string) => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === 'exec');

  async function one(settings = {}): Promise<void> {
    writeConfig([account({ id: 'cx', provider: 'codex', driver: 'cli', local: true, models: [makeModel('default')], profileDir: path.join(home, 'profiles', 'cx') })], settings);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'p' }]);
    expect((await engine.wait([job!.id], 30))[0]!.status).toBe('done');
  }

  it('runs without the extra tools, asking Codex for its feature list only once', async () => {
    const log = fakeCodex();
    await one();
    await one();
    const execs = runs(log);
    expect(execs).toHaveLength(2);
    expect(execs[0]).toContain('features.computer_use=false');
    expect(execs[0]).not.toContain('features.shell_tool=false');
    expect(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('["features"')).length).toBe(1);
  }, 60_000);

  it('keeps every tool when the owner turns this off, or when the list cannot be read', async () => {
    const log = fakeCodex();
    await one({ codexTools: 'all' });
    expect(runs(log)[0]!.join(' ')).not.toContain('features.');
    forgetCodexFeatures();
    const broken = fakeCodex(1);
    await one();
    expect(runs(broken)[0]!.join(' ')).not.toContain('features.');
  }, 60_000);
});
