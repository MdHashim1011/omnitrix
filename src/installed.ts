// `npm install -g` replaces omnitrix's files, but a process that is already running, such as the MCP server
// inside Claude or the background dashboard, keeps the version it started with until it is restarted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { olderVersion } from './dashboard-launch.js';

/** The version in the package.json beside this program's folder, as it is on disk now. */
export function installedVersion(distDir = path.dirname(fileURLToPath(import.meta.url))): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(distDir, '..', 'package.json'), 'utf8'));
    return pkg?.name === 'omnitrix' && typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** A request to restart, when a newer omnitrix is installed than the one that is running. */
export function updateNote(running: string, installed: string | undefined): string | undefined {
  if (!installed || !olderVersion(running, installed)) return undefined;
  return `omnitrix ${installed} is installed, but this omnitrix still runs ${running}. Ask the user to restart the app that runs it, such as Claude, to load the new version.`;
}
