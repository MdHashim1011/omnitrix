// Lockfiles record the exact version of every package a project installs. When several jobs each change one,
// merging them by hand rarely works, and a regenerated lockfile can quietly change versions nobody reviewed.
// This module tells, for a lockfile, which packages were added, changed or removed between two versions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Lockfiles by file name. Only some formats can be read; the rest are still flagged. */
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'pdm.lock', 'composer.lock', 'Gemfile.lock',
  'go.sum', 'packages.lock.json', 'Podfile.lock', 'pubspec.lock', 'mix.lock', 'flake.lock', 'gradle.lockfile',
]);

export function isLockfile(file: string): boolean {
  return LOCKFILES.has(path.posix.basename(file.replace(/\\/g, '/')));
}

/** Package name to the set of versions the lockfile holds for it. */
type Entries = Map<string, Set<string>>;

function put(e: Entries, name: string, version: string | undefined): void {
  if (!name || !version) return;
  let set = e.get(name);
  if (!set) e.set(name, (set = new Set()));
  set.add(version);
}

function npm(text: string): Entries {
  const data = JSON.parse(text) as { packages?: Record<string, { version?: string; name?: string }>; dependencies?: Record<string, unknown> };
  const e: Entries = new Map();
  if (data.packages) {
    for (const [key, pkg] of Object.entries(data.packages)) {
      const at = key.lastIndexOf('node_modules/');
      if (at < 0) continue; // the project itself, or a workspace folder
      put(e, pkg.name ?? key.slice(at + 'node_modules/'.length), pkg.version);
    }
    return e;
  }
  const walk = (deps: Record<string, unknown> | undefined) => {
    for (const [name, raw] of Object.entries(deps ?? {})) {
      const pkg = raw as { version?: string; dependencies?: Record<string, unknown> };
      put(e, name, pkg.version);
      walk(pkg.dependencies);
    }
  };
  walk(data.dependencies);
  return e;
}

/** Cargo.lock, poetry.lock and uv.lock: one [[package]] table per package, with name and version keys. */
function tomlPackages(text: string): Entries {
  const e: Entries = new Map();
  let inPackage = false;
  let name = '';
  let version = '';
  const flush = () => {
    if (inPackage) put(e, name, version);
    name = version = '';
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('[')) {
      flush();
      inPackage = line.trim() === '[[package]]';
      continue;
    }
    if (!inPackage) continue;
    const m = /^(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (m) {
      if (m[1] === 'name') name = m[2]!;
      else version = m[2]!;
    }
  }
  flush();
  return e;
}

function goSum(text: string): Entries {
  const e: Entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [mod, ver] = line.trim().split(/\s+/);
    if (mod && ver) put(e, mod, ver.replace(/\/go\.mod$/, ''));
  }
  return e;
}

function composer(text: string): Entries {
  const data = JSON.parse(text) as { packages?: { name?: string; version?: string }[]; 'packages-dev'?: { name?: string; version?: string }[] };
  const e: Entries = new Map();
  for (const p of [...(data.packages ?? []), ...(data['packages-dev'] ?? [])]) put(e, p.name ?? '', p.version);
  return e;
}

function pipfile(text: string): Entries {
  const data = JSON.parse(text) as Record<string, Record<string, { version?: string }> | undefined>;
  const e: Entries = new Map();
  for (const group of ['default', 'develop']) {
    for (const [name, p] of Object.entries(data[group] ?? {})) put(e, name, p.version?.replace(/^==/, ''));
  }
  return e;
}

const READERS: Record<string, (text: string) => Entries> = {
  'package-lock.json': npm,
  'npm-shrinkwrap.json': npm,
  'Cargo.lock': tomlPackages,
  'poetry.lock': tomlPackages,
  'uv.lock': tomlPackages,
  'go.sum': goSum,
  'composer.lock': composer,
  'Pipfile.lock': pipfile,
};

/** The packages in a lockfile, or undefined for a format omnitrix cannot read. Throws when the text is not valid. */
export function lockEntries(file: string, text: string): Entries | undefined {
  return READERS[path.posix.basename(file.replace(/\\/g, '/'))]?.(text);
}

export interface LockChange {
  name: string;
  from: string;
  to: string;
}

export interface LockDiff {
  file: string;
  /** false for a lockfile format omnitrix cannot read; nothing is then said about its contents */
  supported: boolean;
  /** true when one of the two versions could not be read, for example because of merge conflict markers */
  unreadable?: boolean;
  /** new packages, or new versions next to versions that stay, as name@version */
  added: string[];
  /** packages where a version that was there before is gone, replaced by another */
  changed: LockChange[];
  /** packages that are gone entirely, as name@version */
  removed: string[];
  /** true when nothing was changed or removed; unset when the contents could not be compared */
  additiveOnly?: boolean;
}

const sorted = (s: Set<string>) => [...s].sort();

/** Compares two versions of a lockfile. A missing side (undefined) counts as an empty lockfile. */
export function diffLock(file: string, before: string | undefined, after: string | undefined): LockDiff {
  const base: LockDiff = { file, supported: true, added: [], changed: [], removed: [] };
  const read = READERS[path.posix.basename(file.replace(/\\/g, '/'))];
  if (!read) return { ...base, supported: false };
  let b: Entries;
  let a: Entries;
  try {
    b = before === undefined ? new Map() : read(before);
    a = after === undefined ? new Map() : read(after);
  } catch {
    return { ...base, unreadable: true };
  }
  for (const name of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const was = b.get(name);
    const now = a.get(name);
    if (!was) base.added.push(...sorted(now!).map((v) => `${name}@${v}`));
    else if (!now) base.removed.push(...sorted(was).map((v) => `${name}@${v}`));
    else if ([...was].some((v) => !now.has(v))) base.changed.push({ name, from: sorted(was).join(', '), to: sorted(now).join(', ') });
    else base.added.push(...sorted(now).filter((v) => !was.has(v)).map((v) => `${name}@${v}`));
  }
  base.additiveOnly = !base.changed.length && !base.removed.length;
  return base;
}

function list(items: string[], max = 3): string {
  return items.slice(0, max).join(', ') + (items.length > max ? ', ...' : '');
}

/** One line, such as "package-lock.json: 2 added, 1 changed (a 1.0.0 -> 2.0.0), 0 removed". */
export function describeLock(d: LockDiff): string {
  if (!d.supported) return `${d.file} changed; omnitrix cannot read this format, so review it by hand`;
  if (d.unreadable) return `${d.file} could not be read as a lockfile (it may hold merge conflict markers); review it by hand`;
  if (!d.added.length && d.additiveOnly) return `${d.file}: no package changes`;
  if (d.additiveOnly) return `${d.file}: ${d.added.length} added, nothing changed or removed`;
  const changed = d.changed.length ? ` (${list(d.changed.map((c) => `${c.name} ${c.from} -> ${c.to}`))})` : '';
  const removed = d.removed.length ? ` (${list(d.removed)})` : '';
  return `${d.file}: ${d.added.length} added, ${d.changed.length} changed${changed}, ${d.removed.length} removed${removed}`;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/**
 * Compares the lockfiles in a repository's working copy with a revision, by default HEAD. Without named
 * files it checks every lockfile that differs from that revision, including new ones git does not track yet.
 */
export function checkLockfiles(repo: string, rev = 'HEAD', named?: string[]): LockDiff[] {
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error(`${repo} is not inside a git repository`);
  // real paths on both sides: git prints the long, resolved form, while the folder given may be a Windows
  // short name (RUNNER~1) or go through a link (/var and /private/var on macOS)
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const root = real(top.out.trim());
  if (!git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).ok) throw new Error(`there is no commit "${rev}" in ${root}`);
  let targets: string[];
  if (named?.length) {
    const from = real(repo);
    targets = named.map((f) => {
      const rel = path.relative(root, path.resolve(from, f));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${f} is outside the repository ${root}`);
      return rel.replace(/\\/g, '/');
    });
  } else {
    const changed = git(root, ['diff', '--name-only', '--no-renames', '-z', rev, '--']).out.split('\0');
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).out.split('\0');
    targets = [...new Set([...changed, ...untracked].filter((f) => f && isLockfile(f)))].sort();
  }
  return targets.map((f) => {
    const before = git(root, ['cat-file', 'blob', `${rev}:${f}`]);
    const file = path.join(root, f);
    const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    return diffLock(f, before.ok ? before.out : undefined, after);
  });
}
