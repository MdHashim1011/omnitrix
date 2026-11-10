import { loadConfig, loadHealth } from './store.js';
import { readLedger, summarize } from './usage.js';

/**
 * Claude Code runs this often, so it must be fast and must never throw.
 * It reads files only; it never calls a provider.
 */
export function renderStatusLine(stdinJson: string, now = Date.now()): string {
  const parts: string[] = [];
  try {
    const cfg = loadConfig();
    const health = loadHealth();
    const records = readLedger(now - 32 * 24 * 3600_000);
    const accounts = cfg.accounts.filter((a) => a.enabled);
    if (accounts.length) {
      let ready = 0;
      const shown: string[] = [];
      for (const a of accounts) {
        const h = health[a.id];
        const blocked = h && (h.state === 'auth_error' || ((h.state === 'cooling' || h.state === 'exhausted' || h.state === 'offline') && (h.until ?? 0) > now));
        const s = summarize(a, records, h, now);
        const full = s.percentUsed === 100;
        if (!blocked && !full) ready++;
        let tag: string;
        if (blocked) tag = h!.state === 'auth_error' ? 'login?' : h!.state === 'offline' ? 'off' : 'wait';
        else if (s.measured?.remainingRequests !== undefined) tag = `${s.measured.remainingRequests} left`;
        else if (s.percentUsed !== undefined) tag = `${100 - s.percentUsed}%`;
        else tag = `${s.requestsToday}req`;
        shown.push(`${a.id} ${tag}`);
      }
      const max = 4;
      parts.push(`omnitrix ${ready}/${accounts.length} ready · ${shown.slice(0, max).join(' · ')}${shown.length > max ? ` +${shown.length - max}` : ''}`);
    } else {
      parts.push('omnitrix: no accounts (omnitrix add)');
    }
  } catch {
    parts.push('omnitrix: ?');
  }

  // Claude's own plan usage, which Claude Code passes on stdin (Pro/Max/Ultra only).
  try {
    if (stdinJson.trim()) {
      const j = JSON.parse(stdinJson);
      const five = j?.rate_limits?.five_hour?.used_percentage;
      const week = j?.rate_limits?.seven_day?.used_percentage;
      const bits: string[] = [];
      if (typeof five === 'number') bits.push(`5h ${Math.round(five)}%`);
      if (typeof week === 'number') bits.push(`7d ${Math.round(week)}%`);
      if (bits.length) parts.push(`Claude ${bits.join(' ')}`);
    }
  } catch {
    /* not JSON; ignore */
  }
  return parts.join(' │ ');
}
