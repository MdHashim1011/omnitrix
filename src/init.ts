// Finds what can be connected on this computer, so a new user does not need to know provider ids first.
import { CLI_TOOLS, providerTool, resolveCommand } from './drivers/cli.js';
import { PROVIDERS, type ProviderSpec } from './providers.js';
import type { Config } from './types.js';

export interface Found {
  provider: string;
  name: string;
  /** how it was found; names an environment variable, never its value */
  how: string;
  action: 'add' | 'connected' | 'skip';
  connectedAs?: string[];
  reason?: string;
}

export interface DetectDeps {
  env: Record<string, string | undefined>;
  has: (command: string) => boolean;
  reachable?: (baseUrl: string) => Promise<boolean>;
  providers: ProviderSpec[];
}

// Found but never added by init: the lead itself, and a tool whose provider suspends accounts used this way.
const NOT_AUTOMATIC: Record<string, string> = {
  'claude-code': 'Claude Code is the lead; as a worker it would spend the same Claude quota',
  antigravity: 'Google has suspended accounts used through outside tools; add it yourself if you accept that risk',
};

/** A local server counts when its OpenAI-style model list answers within a moment. */
export async function reachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    return res.ok;
  } catch {
    return false;
  }
}

export const realDeps: DetectDeps = { env: process.env, has: (command) => !!resolveCommand(command), reachable, providers: PROVIDERS };

export async function detect(cfg: Config, deps: DetectDeps = realDeps): Promise<Found[]> {
  const check = deps.reachable ?? reachable;
  const local = await Promise.all(deps.providers.map((p) => (p.local && p.baseUrl ? check(p.baseUrl) : Promise.resolve(false))));
  const found: Found[] = [];
  deps.providers.forEach((spec, i) => {
    let how: string | undefined;
    if (spec.driver === 'cli') {
      const command = CLI_TOOLS[providerTool(spec.id)]?.command ?? spec.cli;
      if (command && deps.has(command)) how = `the ${command} command is installed`;
    } else if (spec.local) {
      if (local[i]) how = `answering at ${spec.baseUrl}`;
    } else if (spec.keyEnv && deps.env[spec.keyEnv]?.trim()) {
      how = `${spec.keyEnv} is set`;
    }
    if (!how) return;
    const connectedAs = cfg.accounts.filter((a) => a.provider === spec.id).map((a) => a.id);
    // a CLI that signs in with an API key (the Gemini CLI) would fail every job without one
    const needsKey = spec.driver === 'cli' && spec.keyEnv && !deps.env[spec.keyEnv]?.trim() ? `it needs ${spec.keyEnv} to be set first` : undefined;
    const reason = NOT_AUTOMATIC[spec.id] ?? needsKey;
    found.push({
      provider: spec.id,
      name: spec.name,
      how,
      action: connectedAs.length ? 'connected' : reason ? 'skip' : 'add',
      ...(connectedAs.length ? { connectedAs } : {}),
      ...(reason && !connectedAs.length ? { reason } : {}),
    });
  });
  return found;
}
