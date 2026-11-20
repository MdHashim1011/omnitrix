import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { makeModel } from '../src/models.js';
import { files, loadHealth, writeJson } from '../src/store.js';
import { readLedger } from '../src/usage.js';
import type { Job } from '../src/types.js';
import { account, chatReply, mockProvider, tempHome, writeConfig } from './helpers.js';

let closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  tempHome();
  closers = [];
});
afterEach(async () => {
  for (const c of closers) await c();
});

describe('local servers', () => {
  it('shows a local server that does not answer as offline, and one that answers as ready', async () => {
    const up = await mockProvider(() => ({ json: { data: [{ id: 'm' }] } }));
    closers.push(up.close);
    writeConfig([
      account({ id: 'up', baseUrl: up.url, local: true }),
      account({ id: 'down', baseUrl: 'http://127.0.0.1:9/v1', local: true }),
      account({ id: 'cloud', baseUrl: 'http://127.0.0.1:9/v1' }),
    ]);
    const engine = new Engine();
    await engine.checkLocal();
    const pool = Object.fromEntries(engine.pool().map((a) => [a.id, a]));
    expect(pool.up!.state).toBe('ready');
    expect(pool.down!.state).toBe('offline');
    expect(pool.down!.reason).toMatch(/not answering at http:\/\/127\.0\.0\.1:9\/v1/);
    // only local servers are probed; a cloud API is never called just to draw the pool
    expect(pool.cloud!.state).toBe('ready');
    expect(up.calls[0]!.path).toMatch(/\/models$/);
  });

  it('clears the offline mark once the server answers again, and probes at most every 30 seconds', async () => {
    const up = await mockProvider(() => ({ json: { data: [] } }));
    closers.push(up.close);
    writeConfig([account({ id: 'local', baseUrl: up.url, local: true })]);
    writeJson(files.health(), { local: { state: 'offline', until: Date.now() + 60_000, reason: `not answering at ${up.url}`, at: Date.now() } });
    const engine = new Engine();
    await engine.checkLocal();
    expect(engine.pool()[0]!.state).toBe('ready');
    await engine.checkLocal();
    expect(up.calls).toHaveLength(1);
  });
});

describe('accounts that keep failing', () => {
  it('rests an account for 10 minutes after three failures in a row', async () => {
    const broken = await mockProvider(() => ({ status: 500, json: { error: { message: 'internal error' } } }));
    closers.push(broken.close);
    writeConfig([account({ id: 'flaky', baseUrl: broken.url, local: true, models: [makeModel('a-model'), makeModel('b-model'), makeModel('c-model')] })]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    await engine.wait([job!.id], 10);
    const h = loadHealth().flaky!;
    expect(h.state).toBe('offline');
    expect(h.reason).toMatch(/failed 3 times in a row/);
    expect(h.until! - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it('does not count rate limits, or failures broken up by a success', async () => {
    // fail, succeed, then fail twice: the success breaks the run, so three failures out of four are not "in a row"
    let n = 0;
    const mixed = await mockProvider(() => (n++ === 1 || n === 5 ? { json: chatReply('ok') } : { status: 500, json: { error: { message: 'internal error' } } }));
    closers.push(mixed.close);
    writeConfig([account({ id: 'mixed', baseUrl: mixed.url, local: true, models: ['a', 'b', 'c', 'd', 'e'].map((m) => makeModel(`${m}-model`)) })]);
    const engine = new Engine();
    const [first] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    await engine.wait([first!.id], 10);
    const [next] = engine.dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    const [done] = await engine.wait([next!.id], 10);
    expect(done!.attempts.map((a) => a.errorKind ?? 'ok')).toEqual(['server', 'server', 'ok']);
    expect(loadHealth().mixed?.reason ?? '').not.toMatch(/in a row/);

    const limited = await mockProvider(() => ({ status: 429, json: { error: { message: 'Rate limit reached' } } }));
    closers.push(limited.close);
    writeConfig([account({ id: 'limited', baseUrl: limited.url, local: true })]);
    const [second] = new Engine().dispatch([{ title: 't', type: 'writing', prompt: 'q' }]);
    await new Engine().wait([second!.id], 5);
    expect(loadHealth().limited!.reason).toBe('rate limited');
  });
});

describe('omnitrix clean --branches', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

  it('removes branches of rejected, failed and merged work, and keeps unmerged work', () => {
    const home = process.env.OMNITRIX_HOME!;
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const branch = (id: string, merge: boolean) => {
      git(repo, 'checkout', '-q', '-b', `omnitrix/${id}`);
      fs.writeFileSync(path.join(repo, `${id}.txt`), id);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', id);
      git(repo, 'checkout', '-q', 'main');
      if (merge) git(repo, 'merge', '-q', '--no-edit', `omnitrix/${id}`);
    };
    const old = Date.now() - 30 * 24 * 3600_000;
    const job = (id: string, over: Partial<Job>) => writeJson(path.join(files.jobs(), `${id}.json`), {
      id, task: { title: id, type: 'code', prompt: 'p', repo }, status: 'done', createdAt: old, updatedAt: old, attempts: [],
      worktree: { path: path.join(files.worktrees(), id), branch: `omnitrix/${id}` }, ...over,
    });
    branch('jrejected', false); job('jrejected', { verdict: 'rejected' });
    branch('jfailed', false); job('jfailed', { status: 'failed' });
    branch('jmerged', true); job('jmerged', { verdict: 'accepted' });
    branch('junmerged', false); job('junmerged', { verdict: 'accepted' });
    branch('junrated', false); job('junrated', {});

    const dry = spawnSync(process.execPath, [cli, 'clean', '--branches', '--dry-run'], { env: { ...process.env, OMNITRIX_HOME: home }, encoding: 'utf8' });
    expect(dry.stdout).toMatch(/would delete 3 branches/);
    // a dry run changes nothing, so it says what it would keep, and names the branches
    expect(dry.stdout).toMatch(/would keep 2 that are not merged: omnitrix\/junmerged, omnitrix\/junrated/);
    expect(git(repo, 'branch', '--list', 'omnitrix/*').stdout.match(/omnitrix\//g)).toHaveLength(5);

    const r = spawnSync(process.execPath, [cli, 'clean', '--branches'], { env: { ...process.env, OMNITRIX_HOME: home }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const left = git(repo, 'branch', '--list', 'omnitrix/*').stdout;
    expect(left).toContain('omnitrix/junmerged');
    expect(left).toContain('omnitrix/junrated');
    expect(left).not.toContain('omnitrix/jrejected');
    expect(left).not.toContain('omnitrix/jfailed');
    expect(left).not.toContain('omnitrix/jmerged');
    expect(r.stdout).toMatch(/deleted 3 branches, kept 2 that are not merged: omnitrix\/junmerged, omnitrix\/junrated/);
    expect(r.stdout).toMatch(/git branch -D/);
    expect(fs.existsSync(path.join(files.jobs(), 'junmerged.json'))).toBe(true);
  }, 60_000);
});

describe('upkeep safeguards', () => {
  const rest = () => ({ state: 'offline' as const, until: Date.now() + 10 * 60_000, reason: 'failed 3 times in a row; resting for 10 minutes', at: Date.now() });

  it('a local probe neither ends nor shortens a longer rest', async () => {
    const up = await mockProvider(() => ({ json: { data: [] } }));
    closers.push(up.close);
    writeConfig([account({ id: 'up', baseUrl: up.url, local: true }), account({ id: 'down', baseUrl: 'http://127.0.0.1:9/v1', local: true })]);
    writeJson(files.health(), { up: rest(), down: rest() });
    await new Engine().checkLocal();
    const h = loadHealth();
    expect(h.up!.reason).toMatch(/in a row/);
    expect(h.down!.reason).toMatch(/in a row/);
    expect(h.down!.until! - Date.now()).toBeGreaterThan(9 * 60_000);
  });

  it('does not blame accounts for a failure before any provider was called', async () => {
    // a repository with no commits cannot give a worker its own checkout
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-empty-'));
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const cli = (id: string) => account({ id, driver: 'cli', provider: 'codex', local: true, models: [makeModel('default')] });
    writeConfig([cli('c1'), cli('c2'), cli('c3')]);
    const engine = new Engine();
    const [job] = engine.dispatch([{ title: 't', type: 'code', prompt: 'q', repo }]);
    const [done] = await engine.wait([job!.id], 10);
    expect(done!.status).toBe('failed');
    expect(Object.values(loadHealth()).map((h) => h.reason ?? '').join(' ')).not.toMatch(/in a row/);
    expect(readLedger()).toHaveLength(0);
  });

  it('lets one failing model rest without resting the account and its healthy models', async () => {
    const mixed = await mockProvider((call) => (/pro/.test(call.body.model) ? { status: 500, json: { error: { message: 'internal error' } }, delayMs: 300 } : { json: chatReply('from the other model') }));
    closers.push(mixed.close);
    writeConfig([account({ id: 'acc', baseUrl: mixed.url, local: true, concurrency: 3, models: [makeModel('big-pro-max'), makeModel('small-mini')] })]);
    const engine = new Engine();
    const jobs = engine.dispatch([1, 2, 3].map((n) => ({ title: `t${n}`, type: 'writing' as const, prompt: `q${n}` })));
    const done = await engine.wait(jobs.map((j) => j.id), 15);
    expect(done.map((j) => j.status)).toEqual(['done', 'done', 'done']);
    expect(loadHealth().acc?.reason ?? '').not.toMatch(/in a row/);
  });
});

describe('omnitrix clean safeguards', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'clean', ...args], { env: { ...process.env }, encoding: 'utf8' });
  const old = Date.now() - 30 * 24 * 3600_000;
  function repoWith(...branches: string[]) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    for (const b of branches) {
      git(repo, 'checkout', '-q', '-b', b);
      fs.writeFileSync(path.join(repo, `${b.replace('/', '-')}.txt`), b);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', b);
      git(repo, 'checkout', '-q', 'main');
    }
    return repo;
  }
  const job = (id: string, repo: string, over: Partial<Job> = {}) => writeJson(path.join(files.jobs(), `${id}.json`), {
    id, task: { title: id, type: 'code', prompt: 'p', repo }, status: 'done', createdAt: old, updatedAt: old, attempts: [],
    worktree: { path: path.join(files.worktrees(), id), branch: `omnitrix/${id}` }, ...over,
  });

  it('changes nothing in a dry run, not even leftover cancel notes', () => {
    fs.mkdirSync(files.jobs(), { recursive: true });
    const note = path.join(files.jobs(), 'jold.cancel');
    fs.writeFileSync(note, '');
    fs.utimesSync(note, new Date(old), new Date(old));
    run('--dry-run', '--branches');
    expect(fs.existsSync(note)).toBe(true);
  });

  it('only deletes the branch omnitrix made for that job', () => {
    const repo = repoWith('keep');
    git(repo, 'checkout', '-q', 'keep');
    job('jtampered', repo, { status: 'failed', worktree: { path: 'x', branch: 'main' } });
    const r = run('--branches');
    expect(git(repo, 'branch', '--list', 'main').stdout).toContain('main');
    expect(r.stdout).not.toMatch(/deleted 1 branch/);
  }, 30_000);

  it('keeps the job record of a kept branch, so a later clean can still decide about it', () => {
    const repo = repoWith('omnitrix/jlater');
    job('jlater', repo, { verdict: 'accepted' });
    run('--branches');
    expect(fs.existsSync(path.join(files.jobs(), 'jlater.json'))).toBe(true);
    git(repo, 'merge', '-q', '--no-edit', 'omnitrix/jlater');
    run('--branches');
    expect(git(repo, 'branch', '--list', 'omnitrix/*').stdout).not.toContain('omnitrix/jlater');
    expect(fs.existsSync(path.join(files.jobs(), 'jlater.json'))).toBe(false);
  }, 30_000);

  it('reports a branch it could not delete', () => {
    const repo = repoWith('omnitrix/jbusy');
    git(repo, 'checkout', '-q', 'omnitrix/jbusy');
    job('jbusy', repo, { verdict: 'rejected' });
    const r = run('--branches');
    expect(r.stdout).toMatch(/could not delete 1/);
    expect(fs.existsSync(path.join(files.jobs(), 'jbusy.json'))).toBe(true);
  }, 30_000);
});

describe('tables in the terminal', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  it('keeps a long model name apart from the next column', () => {
    // seen in real use: "models/gemini-robotics-er-2-streaming-preview6" ran into the first score
    const long = 'models/gemini-robotics-er-2-streaming-preview-extra';
    writeConfig([account({ id: 'g', models: [makeModel('short'), makeModel(long)] })]);
    const env = { ...process.env };
    const models = spawnSync(process.execPath, [cli, 'models', 'g'], { env, encoding: 'utf8' }).stdout;
    expect(models).toMatch(new RegExp(`${long} +[0-9]`));
    const route = spawnSync(process.execPath, [cli, 'route', 'hello'], { env, encoding: 'utf8' }).stdout;
    expect(route).toMatch(new RegExp(`g/${long} +[0-9][.][0-9]{3}`));
  }, 30_000);
});

describe('two code jobs that change the same file', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

  it('tells each job about the other, so their changes are combined rather than copied over each other', () => {
    // seen in real use: copying the second job's file silently dropped the first job's feature
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'omnitrix-overlap-'));
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'f.js'), 'base\n');
    fs.writeFileSync(path.join(repo, 'g.js'), 'g\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const work = (id: string, file: string, text: string) => {
      git(repo, 'checkout', '-q', '-b', `omnitrix/${id}`, 'main');
      fs.writeFileSync(path.join(repo, file), text);
      git(repo, 'commit', '-q', '-am', id);
      git(repo, 'checkout', '-q', 'main');
      const now = Date.now();
      writeJson(path.join(files.jobs(), `${id}.json`), {
        id, status: 'done', createdAt: now, updatedAt: now, attempts: [], task: { title: id, type: 'code', prompt: 'p', repo },
        worktree: { path: path.join(files.worktrees(), id), branch: `omnitrix/${id}` }, verify: { files: [file] },
      });
    };
    work('jcurrency', 'f.js', 'currency\n');
    work('jthousands', 'f.js', 'thousands\n');
    work('jother', 'g.js', 'other\n');
    const engine = new Engine();
    const job = (id: string) => engine.getJob(id)!;
    expect(engine.overlaps(job('jthousands'))).toEqual([{ jobId: 'jcurrency', files: ['f.js'] }]);
    expect(engine.overlaps(job('jcurrency'))).toEqual([{ jobId: 'jthousands', files: ['f.js'] }]);
    expect(engine.overlaps(job('jother'))).toEqual([]);

    // once the first change is in the starting point of a later job, there is nothing to combine
    git(repo, 'checkout', '-q', 'omnitrix/jcurrency', '--', 'f.js');
    git(repo, 'commit', '-q', '-am', 'take currency');
    work('jlater', 'f.js', 'currency and later\n');
    expect(engine.overlaps(job('jlater')).map((o) => o.jobId)).not.toContain('jcurrency');
    // rejected work is not going to be kept, so it is not an overlap either
    writeJson(path.join(files.jobs(), 'jthousands.json'), { ...job('jthousands'), verdict: 'rejected' });
    expect(engine.overlaps(job('jcurrency'))).toEqual([]);
  }, 60_000);
});

describe('omnitrix test with an empty answer (field report)', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  it('does not report success when the model answers with nothing', async () => {
    const empty = await mockProvider(() => ({ json: chatReply('') }));
    closers.push(empty.close);
    writeConfig([account({ id: 'q', baseUrl: empty.url, local: true, models: [makeModel('quiet')] })]);
    // started without blocking: the fake provider answers from this same process
    const { execFile } = await import('node:child_process');
    const r = await new Promise<{ stdout: string; status: number | null }>((resolve) => {
      execFile(process.execPath, [cli, 'test', 'q'], { env: { ...process.env } }, (err, stdout) => resolve({ stdout: String(stdout), status: err ? (typeof err.code === 'number' ? err.code : 1) : 0 }));
    });
    expect(r.stdout).toMatch(/empty/);
    expect(r.stdout).not.toMatch(/^.*ok in/m);
    expect(r.status).not.toBe(0);
  }, 30_000);
});

describe('omnitrix doctor (field report)', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  it('reports an account whose last request failed, and one that was never used, instead of only "ok"', () => {
    process.env.OMNITRIX_TEST_NV_KEY = 'x';
    writeConfig([
      account({ id: 'nv', apiKey: 'env:OMNITRIX_TEST_NV_KEY', models: [makeModel('m')] }),
      account({ id: 'fresh', apiKey: 'env:OMNITRIX_TEST_NV_KEY', models: [makeModel('m')] }),
    ]);
    writeJson(files.health(), { nv: { state: 'auth_error', reason: 'HTTP 404: Function not found for account', at: Date.now() } });
    const out = spawnSync(process.execPath, [cli, 'doctor'], { env: { ...process.env }, encoding: 'utf8' }).stdout;
    expect(out).toMatch(/FAIL\s+nv: last request failed: HTTP 404: Function not found for account/);
    expect(out).toMatch(/fresh: no request has been sent yet; "omnitrix test fresh" sends one/);
  }, 30_000);
});

describe('omnitrix init without --apply (field report)', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');
  it('only lists: it neither starts nor opens the dashboard', () => {
    writeConfig([]);
    const r = spawnSync(process.execPath, [cli, 'init'], { env: { ...process.env, GROQ_API_KEY: 'x' }, encoding: 'utf8' });
    expect(r.stdout).toMatch(/Nothing was changed/);
    expect(r.stdout).not.toMatch(/dashboard:|could not open the dashboard/);
    expect(r.stdout).toMatch(/omnitrix dashboard/);
  }, 30_000);
});
