import { describe, expect, it } from 'vitest';
import { PAGE } from '../src/dashboard.js';

// The page's own functions, cut out of the page the dashboard serves, so the test checks the code a browser runs.
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
const line = (re: RegExp) => PAGE.match(re)![0];
const vars = ['esc', 'fmt', 'money', 'clock', 'span', 'ago'].map((n) => line(new RegExp(`var ${n}=function[^\\n]*`)));
const consts = ['STATES', 'SOURCES', 'GRIP', 'DOTS'].map((n) => line(new RegExp(`var ${n}=[^\\n]*`)));
const page = new Function(`${vars.join('\n')}\n${consts.join('\n')}\n${['icon', 'leftOf', 'windowHtml', 'cardHtml'].map(cut).join('\n')}\nreturn { cardHtml };`)() as {
  cardHtml: (a: Record<string, unknown>, open: Record<string, boolean>, movable: boolean) => string;
};

const usage = { windows: [], source: 'untracked', requestsToday: 0, failedToday: 0, tokensToday: 0, costToday: 0 };
const acc = (extra: Record<string, unknown> = {}) => ({ id: 'my-gemini', label: 'My <Gemini>', state: 'ready', driver: 'openai', models: ['m'], usage, ...extra });

describe('the menu on an account card', () => {
  it('has a menu button in the card head, named for the account, closed until opened', () => {
    const html = page.cardHtml(acc(), {}, true);
    expect(html).toContain('<button type="button" class="more" data-menu="my-gemini" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for My &lt;Gemini&gt;"');
    // the button sits beside the state, at the top right of the card
    expect(html).toMatch(/<div class="side"><span class="state s-ok">.*?<\/span><button type="button" class="more"/);
  });

  it('no longer has the pencil beside the name', () => {
    expect(PAGE).not.toContain('data-rename');
    expect(PAGE).not.toContain('&#9998;');
    expect(page.cardHtml(acc(), {}, false)).toContain('<div class="name"><h3>My &lt;Gemini&gt;</h3></div>');
  });

  it('marks a team account, whose name the team file sets', () => {
    expect(page.cardHtml(acc({ team: true }), {}, false)).toContain('<article class="card" data-id="my-gemini" data-team=""');
    expect(page.cardHtml(acc(), {}, false)).not.toContain('data-team');
    expect(PAGE).toContain("off:function(card){return card.hasAttribute('data-team')?'Its name is set in the team file.':''}");
  });

  it('holds live updates while the menu is open and draws the newest one after', () => {
    expect(PAGE).toContain('if(sorting||renaming||menu||Date.now()<settleUntil){held=raw;');
    expect(PAGE).toContain('if(sorting||renaming||menu)return;');
    // the stream's sign of life must not put the older state on screen over a newer one that waits
    expect(PAGE).toContain('if(lastRaw&&!held)show(lastRaw,false)');
  });
});
