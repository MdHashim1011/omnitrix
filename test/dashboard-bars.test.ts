import { describe, expect, it } from 'vitest';
import { PAGE } from '../src/dashboard.js';

// The page's own functions, taken from the page that the dashboard serves, so the test checks the code a
// browser runs. Each one is cut out by matching its braces.
function cut(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name} in the page`);
  let depth = 0;
  for (let i = PAGE.indexOf('{', start); i < PAGE.length; i++) {
    if (PAGE[i] === '{') depth++;
    else if (PAGE[i] === '}' && --depth === 0) return PAGE.slice(start, i + 1);
  }
  throw new Error(`function ${name} does not end`);
}
const helpers = ['esc', 'fmt', 'clock', 'span'].map((n) => PAGE.match(new RegExp(`var ${n}=function[^\\n]*`))![0]).join('\n');
const page = new Function(`${helpers}\n${cut('leftOf')}\n${cut('windowHtml')}\nreturn { windowHtml };`)() as {
  windowHtml: (w: Record<string, unknown>, held?: Record<string, unknown> | null) => string;
};

const minute = { name: '1 minute', unit: 'requests', used: 0, limit: 20, remaining: 20 };
const day = { name: '24 hours', unit: 'requests', used: 50, limit: 50, remaining: 0 };

// From the owner: OpenRouter's daily limit was used up, yet its minute bar was full and blue, as if ready
describe('limit bars on an account card', () => {
  it('draws a window with room as set aside while another window of the account is empty', () => {
    const html = page.windowHtml(minute, day);
    expect(html).toContain('<i class="held"');
    expect(html).toContain('Not usable until the 24 hours limit resets');
    expect(html).toContain('aria-valuetext="20 of 20 requests left, not usable until the 24 hours limit resets"');
    // the amount itself stays true
    expect(html).toContain('>20 of 20 requests left<');
  });

  it('names the reset time when the empty window has one, and the provider when it is the provider', () => {
    const at = Date.now() + 3 * 3600_000;
    expect(page.windowHtml(minute, { ...day, resetsAt: at })).toMatch(/Not usable until the 24 hours limit resets, \w+/);
    expect(page.windowHtml(minute, {})).toContain('Not usable until the provider lets this account work again');
  });

  it('draws windows as before when nothing holds them', () => {
    expect(page.windowHtml(minute, null)).toContain('<i class=""');
    expect(page.windowHtml(minute, null)).not.toContain('Not usable');
    expect(page.windowHtml({ ...minute, remaining: 2 }, null)).toContain('<i class="low"');
    // the empty window itself stays red, held or not
    expect(page.windowHtml(day, minute)).toContain('<i class="out"');
  });

  it('holds a full window only while another one is empty, on the card', () => {
    // the card passes the first other empty window, or the provider's stop when the account is out of quota
    expect(PAGE).toContain("var empty=u.windows.filter(function(w){return leftOf(w)<=0});");
    expect(PAGE).toContain("windowHtml(w,empty.filter(function(o){return o!==w})[0]||(a.state==='exhausted'?{}:null),");
    // the provider note only when every bar still has room, since an empty bar is omnitrix's own limit
    expect(PAGE).toContain("u.windows.every(function(w){return w.remaining>0})");
  });
});
