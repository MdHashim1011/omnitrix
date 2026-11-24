import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { files } from './store.js';

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout.trim();
}

export function isGitRepo(dir: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/**
 * Give a job its own copy of the repo on a new branch, so parallel workers never touch each other's files.
 * The branch starts from the repo's current HEAD.
 */
export function createWorktree(repo: string, jobId: string): { path: string; branch: string; root: string; gitDir: string } {
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  const branch = `omnitrix/${jobId}`;
  const dir = path.join(files.worktrees(), jobId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  try {
    // read before any worker runs: afterwards the worker could point .git anywhere
    const gitDir = git(dir, ['rev-parse', '--absolute-git-dir']);
    stripAgentConfig(dir);
    return { path: dir, branch, root, gitDir };
  } catch (err) {
    discardWorktree(root, dir, branch);
    throw err;
  }
}

// Options for every git command in a worker's folder. The worker may have edited anything there, so git
// uses the git folder recorded when the worktree was made, and runs no hooks and no file monitor.
function workerGit(dir: string, gitDir: string | undefined): string[] {
  const noHooks = path.join(files.worktrees(), '.no-hooks');
  fs.mkdirSync(noHooks, { recursive: true });
  const where = gitDir ? ['--git-dir', gitDir, '--work-tree', dir] : [];
  return [...where, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooks}`];
}

/**
 * A throwaway copy of the repo at its HEAD, on no branch, with agent settings removed. Read-only tasks for
 * agent CLIs run here, so a worker can neither change the real repo nor load the repo's own hooks.
 */
export function createScratch(repo: string, jobId: string): { path: string; root: string } {
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  // a new name for each attempt, so a copy that Windows would not let go of never blocks the next one
  const dir = path.join(files.worktrees(), `${jobId}-ro-${Date.now().toString(36)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '--detach', dir, 'HEAD']);
  try {
    stripAgentConfig(dir);
  } catch (err) {
    removeScratch(root, dir);
    throw err;
  }
  return { path: dir, root };
}

/** Remove a throwaway copy made by createScratch. */
export function removeScratch(root: string, dir: string): void {
  removeWorktree(root, dir);
  fs.rmSync(dir, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: root, windowsHide: true });
}

/** Agent settings a repository can carry: hooks, MCP servers, plugins and permission overrides. */
export const AGENT_CONFIG = ['.claude', '.mcp.json', '.codex', '.gemini', '.qwen', '.opencode', 'opencode.json', 'opencode.jsonc', '.agy', '.antigravity'];

/**
 * A repo can carry its own agent settings (hooks, MCP servers) that a worker CLI would run.
 * Remove them from the worker's copy so a task can never execute repo-provided hooks.
 */
export function stripAgentConfig(dir: string): void {
  for (const name of AGENT_CONFIG) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Commit whatever the worker changed and report a short diff summary. */
export function finishWorktree(dir: string, message: string, gitDir?: string): { diffStat: string; changed: boolean } {
  const safe = workerGit(dir, gitDir);
  git(dir, [...safe, 'add', '-A']);
  // the files removed by stripAgentConfig must not show up as deletions
  for (const name of AGENT_CONFIG) {
    spawnSync('git', [...safe, 'reset', '-q', 'HEAD', '--', name], { cwd: dir, windowsHide: true });
  }
  const staged = spawnSync('git', [...safe, 'diff', '--cached', '--quiet'], { cwd: dir, windowsHide: true });
  if (staged.status === 0) return { diffStat: 'no changes', changed: false };
  // use the repo owner's git identity; only fall back when none is set
  const hasIdentity = spawnSync('git', [...safe, 'config', 'user.email'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim() !== '';
  const identity = hasIdentity ? [] : ['-c', 'user.name=omnitrix', '-c', 'user.email=omnitrix@localhost'];
  git(dir, [...safe, ...identity, 'commit', '-q', '--no-verify', '-m', message]);
  const stat = git(dir, [...safe, 'diff', '--stat', 'HEAD~1', 'HEAD']);
  return { diffStat: stat, changed: true };
}

/** The files changed by the last commit on the worker's branch, read with the recorded git folder. */
export function changedFiles(dir: string, gitDir?: string): string[] {
  // without rename detection a moved file shows both its old and its new path, so a move cannot hide a
  // change to a file the task did not name; -z keeps unusual names exactly as they are
  const out = spawnSync('git', [...workerGit(dir, gitDir), 'diff', '--name-only', '--no-renames', '-z', 'HEAD~1', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? out.stdout.split('\0').filter(Boolean) : [];
}

export function removeWorktree(repoRoot: string, dir: string): void {
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot, windowsHide: true });
}

/** Throw away a worker's copy and its branch (used before retrying a job on another account). */
export function discardWorktree(repoRoot: string, dir: string, branch: string): void {
  removeWorktree(repoRoot, dir);
  spawnSync('git', ['branch', '-D', branch], { cwd: repoRoot, windowsHide: true });
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // a process the worker left behind can still hold a file on Windows; `omnitrix clean` removes it later
  }
}

/** A file's text at a revision of the worker's branch, or undefined when it does not exist there. */
export function fileText(dir: string, rev: string, file: string, gitDir?: string): string | undefined {
  const out = spawnSync('git', [...workerGit(dir, gitDir), 'cat-file', 'blob', `${rev}:${file}`], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return out.status === 0 ? out.stdout : undefined;
}

/** The git object id of a file at a revision, or '' when the file or the revision does not exist there. */
export function fileVersion(repo: string, rev: string, file: string): string {
  const out = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}:${file}`], { cwd: repo, encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? out.stdout.trim() : '';
}

/** True when everything on the branch is already in the repo's current HEAD. */
export function branchMerged(repo: string, branch: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD'], { cwd: repo, windowsHide: true }).status === 0;
}

export function branchExists(repo: string, branch: string): boolean {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, windowsHide: true }).status === 0;
}

export function deleteBranch(repo: string, branch: string): boolean {
  return spawnSync('git', ['branch', '-D', branch], { cwd: repo, windowsHide: true }).status === 0;
}

/** Remove a finished job's checkout but keep its branch, so accepted work can still be merged later. */
export function pruneWorktree(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const common = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  if (common.status === 0) {
    const root = path.dirname(path.resolve(dir, common.stdout.trim()));
    removeWorktree(root, dir);
    spawnSync('git', ['worktree', 'prune'], { cwd: root, windowsHide: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function tryGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/**
 * How far the repository's HEAD has moved past the commit a job's branch started from, and which files
 * changed there. Undefined when the branch is gone or already merged.
 */
export function behind(repo: string, branch: string): { commits: number; files: string[] } | undefined {
  const base = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}~1`]);
  if (!base.ok || branchMerged(repo, branch)) return undefined;
  const count = tryGit(repo, ['rev-list', '--count', `${base.out}..HEAD`]);
  if (!count.ok) return undefined;
  const commits = Number(count.out) || 0;
  if (!commits) return { commits: 0, files: [] };
  const diff = tryGit(repo, ['diff', '--name-only', '--no-renames', '-z', base.out, 'HEAD']);
  return { commits, files: diff.ok ? diff.out.split('\0').filter(Boolean) : [] };
}

/** The commit a branch points at, read in the repository itself; undefined when the branch is gone. */
export function branchTip(repo: string, branch: string): string | undefined {
  const tip = tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return tip.ok && tip.out ? tip.out : undefined;
}

/**
 * What changed after omnitrix checked a job at `commit`: whether the branch now points elsewhere, and which
 * tracked files in the job's checkout differ from its commit. A merge takes only the commit, while the test ran
 * in the checkout. Untracked files are left out, because a test's build output is untracked too. Undefined when
 * the branch is gone.
 */
export function sinceCheck(repo: string, branch: string, commit: string, dir: string, gitDir: string | undefined): { branchMoved: boolean; uncommitted: string[] } | undefined {
  const tip = branchTip(repo, branch);
  if (!tip) return undefined;
  let uncommitted: string[] = [];
  // only with the git folder recorded when the checkout was made, never through the worker's own .git file
  if (gitDir && fs.existsSync(dir)) {
    const r = spawnSync('git', ['--no-optional-locks', ...workerGit(dir, gitDir), 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames'], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) {
      uncommitted = r.stdout.split('\0').filter(Boolean).map((line) => line.slice(3))
        // omnitrix removed these before the worker ran; their absence is not a change
        .filter((f) => !AGENT_CONFIG.some((name) => f === name || f.startsWith(`${name}/`)));
    }
  }
  return { branchMoved: tip !== commit, uncommitted };
}

export type RebaseOutcome =
  | { status: 'rebased'; path: string; gitDir: string; root: string; onto: string; diffStat: string }
  | { status: 'up_to_date' }
  | { status: 'conflict'; files: string[] }
  | { status: 'not_possible'; reason: string };

function dropCheckout(root: string, dir: string): boolean {
  // from the repository, never from inside the checkout, whose .git the worker could have changed
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, windowsHide: true });
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // reported below
  }
  spawnSync('git', ['worktree', 'prune'], { cwd: root, windowsHide: true });
  return !fs.existsSync(dir);
}

/**
 * Moves a job's one commit onto the repository's current HEAD. The rebase runs in a new checkout made for
 * it, without hooks, because the job's own checkout was in the worker's hands. On a conflict it is undone
 * and nothing changes; on success the branch moves and the new checkout takes the old one's place.
 */
export function rebaseBranch(repo: string, jobId: string, branch: string, oldPath: string): RebaseOutcome {
  const root = git(repo, ['rev-parse', '--show-toplevel']);
  const onto = git(root, ['rev-parse', 'HEAD']);
  const tip = git(root, ['rev-parse', `refs/heads/${branch}`]);
  const base = git(root, ['rev-parse', `refs/heads/${branch}~1`]);
  if (base === onto) return { status: 'up_to_date' };
  // a new name for each run, so two runs never share a checkout and a checkout that could not be moved
  // back (and so became the job's own) is never removed by the next run as if it were left over
  const tmp = path.join(files.worktrees(), `${jobId}.rebase-${Date.now().toString(36)}`);
  // The checkout and the rebase write the worker's files, so its .gitattributes and .lfsconfig apply: Git LFS
  // must not download from an address the worker chose, and no submodule it names is fetched.
  const noFetch = ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', '-c', 'submodule.recurse=false'];
  const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' };
  const run = (cwd: string, args: string[]) => spawnSync('git', [...noFetch, ...args], { cwd, encoding: 'utf8', windowsHide: true, env });
  const add = run(root, ['worktree', 'add', '--detach', tmp, tip]);
  if (add.status !== 0) {
    dropCheckout(root, tmp);
    return { status: 'not_possible', reason: `a checkout for the rebase could not be made: ${(add.stderr || '').trim().slice(0, 300)}` };
  }
  const safe = workerGit(tmp, undefined);
  const hasIdentity = tryGit(tmp, ['config', 'user.email']).out !== '';
  const identity = hasIdentity ? [] : ['-c', 'user.name=omnitrix', '-c', 'user.email=omnitrix@localhost'];
  const r = run(tmp, [...safe, ...identity, 'rebase', '--quiet', onto]);
  if (r.status !== 0) {
    const conflicts = tryGit(tmp, ['diff', '--name-only', '--diff-filter=U', '-z']).out.split('\0').filter(Boolean);
    // removing the temporary checkout also drops the stopped rebase, which lives in that checkout's own git folder
    dropCheckout(root, tmp);
    if (!conflicts.length) return { status: 'not_possible', reason: `git rebase failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}` };
    return { status: 'conflict', files: conflicts };
  }
  const newTip = git(tmp, ['rev-parse', 'HEAD']);
  if (!dropCheckout(root, oldPath)) {
    dropCheckout(root, tmp);
    return { status: 'not_possible', reason: `the job's checkout ${oldPath} could not be removed; a program may still have files open in it` };
  }
  // moves the branch only if nothing else moved it meanwhile, for example a second rebase of the same job
  if (tryGit(root, ['update-ref', `refs/heads/${branch}`, newTip, tip]).ok === false) {
    dropCheckout(root, tmp);
    run(root, ['worktree', 'add', oldPath, branch]);
    return { status: 'not_possible', reason: `the branch ${branch} changed while it was being rebased; it was left as it is` };
  }
  // From here on the branch holds the rebased commit, so the result is reported even if a step below fails:
  // the checkout may then stay detached or under its temporary name.
  run(tmp, [...safe, 'switch', '-q', branch]);
  let where = tmp;
  if (spawnSync('git', ['worktree', 'move', tmp, oldPath], { cwd: root, windowsHide: true }).status === 0) where = oldPath;
  const gitDir = tryGit(where, ['rev-parse', '--absolute-git-dir']).out || path.join(root, '.git', 'worktrees', path.basename(where));
  const diffStat = tryGit(where, ['diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD~1', 'HEAD']).out;
  return { status: 'rebased', path: where, gitDir, root, onto, diffStat };
}
