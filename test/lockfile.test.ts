import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLockfiles, describeLock, diffLock, isLockfile, lockEntries } from '../src/lockfile.js';

const npm3 = (deps: Record<string, string>) =>
  JSON.stringify({
    name: 'app',
    lockfileVersion: 3,
    packages: { '': { name: 'app' }, ...Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }])) },
  });

describe('which files are lockfiles', () => {
  it('knows the common lockfiles by name, in any folder', () => {
    for (const f of ['package-lock.json', 'web/package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'composer.lock', 'Pipfile.lock', 'Gemfile.lock', 'bun.lock']) {
      expect(isLockfile(f), f).toBe(true);
    }
  });

  it('does not take ordinary files for lockfiles', () => {
    for (const f of ['package.json', 'Cargo.toml', 'src/lock.ts', 'go.mod', 'my-package-lock.json.bak']) expect(isLockfile(f), f).toBe(false);
  });
});

describe('reading the packages in a lockfile', () => {
  it('reads npm lockfiles of version 2 and 3, including nested copies', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/b/node_modules/a': { version: '0.9.0' } },
    });
    const e = lockEntries('package-lock.json', text)!;
    expect([...e.get('a')!].sort()).toEqual(['0.9.0', '1.0.0']);
    expect([...e.get('b')!]).toEqual(['2.0.0']);
    expect(e.has('')).toBe(false);
  });

  it('reads npm lockfiles of version 1', () => {
    const text = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { c: { version: '3.0.0' } } } } });
    const e = lockEntries('npm-shrinkwrap.json', text)!;
    expect([...e.get('a')!]).toEqual(['1.0.0']);
    expect([...e.get('c')!]).toEqual(['3.0.0']);
  });

  it('reads Cargo, Poetry and uv lockfiles', () => {
    const text = '# generated\nversion = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.1"\nsource = "x"\n\n[[package]]\nname = "rand"\nversion = "0.8.5"\n';
    for (const f of ['Cargo.lock', 'poetry.lock', 'uv.lock']) {
      const e = lockEntries(f, text)!;
      expect([...e.get('serde')!]).toEqual(['1.0.1']);
      expect([...e.get('rand')!]).toEqual(['0.8.5']);
      expect(e.size).toBe(2);
    }
  });

  it('reads go.sum, counting a module once per version', () => {
    const text = 'golang.org/x/text v0.3.0 h1:abc=\ngolang.org/x/text v0.3.0/go.mod h1:def=\ngithub.com/a/b v1.2.0/go.mod h1:x=\n';
    const e = lockEntries('go.sum', text)!;
    expect([...e.get('golang.org/x/text')!]).toEqual(['v0.3.0']);
    expect([...e.get('github.com/a/b')!]).toEqual(['v1.2.0']);
  });

  it('reads Composer and Pipfile lockfiles', () => {
    const c = lockEntries('composer.lock', JSON.stringify({ packages: [{ name: 'a/b', version: '1.0' }], 'packages-dev': [{ name: 'c/d', version: '2.0' }] }))!;
    expect([...c.get('a/b')!]).toEqual(['1.0']);
    expect([...c.get('c/d')!]).toEqual(['2.0']);
    const p = lockEntries('Pipfile.lock', JSON.stringify({ default: { requests: { version: '==2.31.0' } }, develop: { pytest: { version: '==8.0.0' } } }))!;
    expect([...p.get('requests')!]).toEqual(['2.31.0']);
    expect([...p.get('pytest')!]).toEqual(['8.0.0']);
  });

  it('says when it cannot read a format', () => {
    expect(lockEntries('yarn.lock', 'a@1:\n  version "1"\n')).toBeUndefined();
  });

  it('throws on a lockfile that is not valid, such as one with merge conflict markers', () => {
    expect(() => lockEntries('package-lock.json', '<<<<<<< HEAD\n{}')).toThrow();
  });
});

describe('comparing two versions of a lockfile', () => {
  it('reports added, changed and removed packages', () => {
    const d = diffLock('package-lock.json', npm3({ a: '1.0.0', b: '1.0.0', gone: '1.0.0' }), npm3({ a: '1.0.0', b: '2.0.0', fresh: '0.1.0' }));
    expect(d.supported).toBe(true);
    expect(d.added).toEqual(['fresh@0.1.0']);
    expect(d.changed).toEqual([{ name: 'b', from: '1.0.0', to: '2.0.0' }]);
    expect(d.removed).toEqual(['gone@1.0.0']);
    expect(d.additiveOnly).toBe(false);
  });

  it('counts an extra copy of a package that keeps the old version as an addition', () => {
    const before = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { version: '1.0.0' } } });
    const after = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/a': { version: '1.0.0' }, 'node_modules/x/node_modules/a': { version: '2.0.0' } } });
    const d = diffLock('package-lock.json', before, after);
    expect(d.added).toEqual(['a@2.0.0']);
    expect(d.changed).toEqual([]);
    expect(d.additiveOnly).toBe(true);
  });

  it('treats a new lockfile as all additions and a deleted one as all removals', () => {
    expect(diffLock('package-lock.json', undefined, npm3({ a: '1.0.0' }))).toMatchObject({ added: ['a@1.0.0'], additiveOnly: true });
    expect(diffLock('package-lock.json', npm3({ a: '1.0.0' }), undefined)).toMatchObject({ removed: ['a@1.0.0'], additiveOnly: false });
  });

  it('reports a format it cannot read without claiming anything about its contents', () => {
    const d = diffLock('yarn.lock', 'a', 'b');
    expect(d).toMatchObject({ supported: false, added: [], changed: [], removed: [] });
    expect(d.additiveOnly).toBeUndefined();
    expect(describeLock(d)).toBe('yarn.lock changed; omnitrix cannot read this format, so review it by hand');
  });

  it('reports a lockfile it cannot parse', () => {
    const d = diffLock('package-lock.json', npm3({ a: '1.0.0' }), '<<<<<<< HEAD');
    expect(d.unreadable).toBe(true);
    expect(d.additiveOnly).toBeUndefined();
    expect(describeLock(d)).toMatch(/package-lock\.json could not be read/);
  });

  it('describes the change in one line', () => {
    expect(describeLock(diffLock('package-lock.json', npm3({ a: '1.0.0' }), npm3({ a: '1.0.0', b: '1.0.0' })))).toBe('package-lock.json: 1 added, nothing changed or removed');
    expect(describeLock(diffLock('package-lock.json', npm3({ a: '1.0.0', c: '1.0.0' }), npm3({ a: '2.0.0' })))).toBe('package-lock.json: 0 added, 1 changed (a 1.0.0 -> 2.0.0), 1 removed (c@1.0.0)');
    expect(describeLock(diffLock('package-lock.json', npm3({ a: '1.0.0' }), npm3({ a: '1.0.0' })))).toBe('package-lock.json: no package changes');
  });
});

describe('checking a lockfile against a git revision', () => {
  function repo(): { dir: string; g: (...a: string[]) => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-lock-'));
    const g = (...a: string[]) => {
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
    };
    g('init', '-q');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), npm3({ a: '1.0.0' }));
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'Cargo.lock'), '[[package]]\nname = "serde"\nversion = "1.0.0"\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
    return { dir, g };
  }

  it('compares the working copy with HEAD for every lockfile that changed', () => {
    const { dir } = repo();
    fs.writeFileSync(path.join(dir, 'package-lock.json'), npm3({ a: '1.0.0', b: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'web', 'Cargo.lock'), '[[package]]\nname = "serde"\nversion = "2.0.0"\n');
    const results = checkLockfiles(dir, 'HEAD');
    expect(results.map((r) => r.file).sort()).toEqual(['package-lock.json', 'web/Cargo.lock']);
    expect(results.find((r) => r.file === 'package-lock.json')!.additiveOnly).toBe(true);
    expect(results.find((r) => r.file === 'web/Cargo.lock')!.changed).toEqual([{ name: 'serde', from: '1.0.0', to: '2.0.0' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('checks a named lockfile even when it has not changed, and compares with any revision', () => {
    const { dir, g } = repo();
    fs.writeFileSync(path.join(dir, 'package-lock.json'), npm3({ a: '1.1.0' }));
    g('commit', '-q', '-am', 'bump');
    expect(checkLockfiles(dir, 'HEAD', ['package-lock.json'])[0]).toMatchObject({ file: 'package-lock.json', changed: [] });
    expect(checkLockfiles(dir, 'HEAD~1', ['package-lock.json'])[0]!.changed).toEqual([{ name: 'a', from: '1.0.0', to: '1.1.0' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a revision that does not exist', () => {
    const { dir } = repo();
    expect(() => checkLockfiles(dir, 'no-such-branch')).toThrow(/no-such-branch/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a named file outside the repository', () => {
    const { dir } = repo();
    expect(() => checkLockfiles(dir, 'HEAD', ['../package-lock.json'])).toThrow(/outside/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the lockcheck command', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-lockcli-home-'));
      execFile(process.execPath, [cli, 'lockcheck', ...args], { env: { ...process.env, OMNITRIX_HOME: home }, encoding: 'utf8' }, (err, stdout, stderr) => {
        fs.rmSync(home, { recursive: true, force: true });
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout + stderr });
      });
    });

  function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-lockcli-'));
    const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    g('init', '-q');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), npm3({ a: '1.0.0' }));
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
    return dir;
  }

  it('passes when the regenerated lockfile only adds packages', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'package-lock.json'), npm3({ a: '1.0.0', b: '1.0.0' }));
    const r = await run(['--repo', dir]);
    expect(r).toEqual({ code: 0, out: 'package-lock.json: 1 added, nothing changed or removed\n' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails and names the package when an existing version changed', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'package-lock.json'), npm3({ a: '2.0.0' }));
    const r = await run(['--repo', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('a 1.0.0 -> 2.0.0');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails for a lockfile it cannot read, so it is reviewed by hand', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'yarn.lock'), 'a@1:\n  version "1"\n');
    const r = await run(['--repo', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('yarn.lock changed; omnitrix cannot read this format');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('says so when no lockfile changed', async () => {
    const dir = repo();
    expect(await run(['--repo', dir])).toEqual({ code: 0, out: 'no lockfile differs from HEAD\n' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('advice when two jobs changed the same files', () => {
  it('asks Claude to combine ordinary files but to regenerate a lockfile', async () => {
    const { clashNote } = await import('../src/mcp.js');
    expect(clashNote([{ jobId: 'jabc1', files: ['src/a.ts', 'package-lock.json'] }])).toBe(
      'src/a.ts also changed by job jabc1: combine the changes, do not copy one over the other; package-lock.json also changed by job jabc1: do not combine by hand; regenerate after merging, then run omnitrix lockcheck',
    );
    expect(clashNote([{ jobId: 'jabc2', files: ['web/Cargo.lock'] }])).toBe('web/Cargo.lock also changed by job jabc2: do not combine by hand; regenerate after merging, then run omnitrix lockcheck');
    expect(clashNote([])).toBe('');
  });
});
