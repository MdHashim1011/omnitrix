import type { Account, DriverRequest, DriverResult } from '../types.js';
import { listAnthropicModels, runAnthropic } from './anthropic.js';
import { runCli } from './cli.js';
import { listOpenAIModels, runOpenAI } from './openai.js';

export function runDriver(req: DriverRequest, edit = false): Promise<DriverResult> {
  switch (req.account.driver) {
    case 'openai':
      return runOpenAI(req);
    case 'anthropic':
      return runAnthropic(req);
    case 'cli':
      return runCli(req, edit);
  }
}

/** Ask the provider which models it has. CLI tools do not support this. */
export async function discoverModels(account: Account): Promise<string[]> {
  if (account.driver === 'openai') return listOpenAIModels(account);
  if (account.driver === 'anthropic') return listAnthropicModels(account);
  return [];
}
