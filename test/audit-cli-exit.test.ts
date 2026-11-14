import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/drivers/cli.js';
import { makeModel } from '../src/models.js';
import { account, tempHome } from './helpers.js';

const cleanups: (() => void)[] = [];
let home = '';
beforeEach(() => {
  home = tempHome();
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A fake codex that writes a full answer and then exits with `code`. */
function fakeCodex(code: number): void {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-exit-'));
  const script = path.join(bin, 'fake-codex.js');
  fs.writeFileSync(script, `const fs=require('fs');const args=process.argv.slice(2);
process.stdin.resume();process.stdin.on('end',()=>{
  fs.writeFileSync(args[args.indexOf('-o')+1],'half an answer');
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  process.exit(${code});
});`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), `@ECHO off\r\nnode "${script}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  cleanups.push(() => {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });
}

describe('an agent CLI that crashes', () => {
  const acc = () => account({ id: 'cx', provider: 'codex', driver: 'cli', models: [makeModel('default')], profileDir: path.join(home, 'profiles', 'cx') });

  it('fails even when it wrote an answer first, because the answer may be cut off', async () => {
    fakeCodex(1);
    await expect(runCli({ account: acc(), model: 'default', prompt: 'p', timeoutMs: 20_000 }, false)).rejects.toThrow(/exited with code 1/);
  }, 30_000);

  it('succeeds when it exits cleanly', async () => {
    fakeCodex(0);
    await expect(runCli({ account: acc(), model: 'default', prompt: 'p', timeoutMs: 20_000 }, false)).resolves.toMatchObject({ text: 'half an answer' });
  }, 30_000);
});
