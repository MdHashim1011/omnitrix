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

export function removeWorktree(repoRoot: string, dir: string): void {
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot, windowsHide: true });
}

/** Throw away a worker's copy and its branch (used before retrying a job on another account). */
export function discardWorktree(repoRoot: string, dir: string, branch: string): void {
  removeWorktree(repoRoot, dir);
  spawnSync('git', ['branch', '-D', branch], { cwd: repoRoot, windowsHide: true });
  fs.rmSync(dir, { recursive: true, force: true });
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
