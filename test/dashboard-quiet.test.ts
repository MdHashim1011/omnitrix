import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE } from '../src/dashboard.js';
import { dashboardOpening, paneHint } from '../src/dashboard-launch.js';

// From the owner, after renaming an account with the mouse: a blue ring stayed around the card's menu button,
// the "Renamed to ..." line stayed for good, and `omnitrix dashboard` in the Claude app's terminal opened Chrome.

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

class Classes {
  set = new Set<string>();
  add(c: string) { this.set.add(c); }
  remove(c: string) { this.set.delete(c); }
  contains(c: string) { return this.set.has(c); }
  toggle(c: string, on: boolean) { if (on) this.set.add(c); else this.set.delete(c); }
}
const element = (id = '') => ({ id, textContent: '', classList: new Classes(), focused: false, focus() { this.focused = true; } });

// the page's note, fadeLater and endRename, with the few page globals they use replaced by fakes
function pageWith(msg: ReturnType<typeof element>, button: ReturnType<typeof element>) {
  const body = `var document={getElementById:function(){return msg},addEventListener:function(){}};
var say=function(){};var held=null,lastRaw='',heldLive=false,drawnCards='',renaming='a',openAfter=null;
var show=function(){};var openMenu=function(){};
var cardOf=function(){return {querySelector:function(){return button}}};
${line(/var NOTE_MS=[^\n]*/)}
${['note', 'fadeLater', 'endRename'].map(cut).join('\n')}
return { note: note, endRename: endRename };`;
  return new Function('msg', 'button', body)(msg, button) as {
    note: (text: string, warn: boolean) => void;
    endRename: (id: string, text: string, warn: boolean, label: string | undefined, refocus: boolean, byKey: boolean) => void;
  };
}

describe('the line under the Accounts heading', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets a confirmation go after a few seconds', () => {
    const msg = element('order-msg');
    pageWith(msg, element()).note('renamed to This PC.', false);
    expect(msg.textContent).toBe('Renamed to This PC.');
    vi.advanceTimersByTime(5900);
    expect(msg.textContent).toBe('Renamed to This PC.');
    vi.advanceTimersByTime(200);
    expect(msg.textContent).toBe('');
  });

  it('keeps a warning until the next action replaces it', () => {
    const msg = element('order-msg');
    pageWith(msg, element()).note('Could not rename: omnitrix did not answer.', true);
    vi.advanceTimersByTime(60_000);
    expect(msg.textContent).toBe('Could not rename: omnitrix did not answer.');
  });

  it('gives a newer line its own full time, and does not clear a newer warning', () => {
    const msg = element('order-msg');
    const page = pageWith(msg, element());
    page.note('Renamed to A.', false);
    vi.advanceTimersByTime(4000);
    page.note('Renamed to B.', false);
    vi.advanceTimersByTime(4000);
    expect(msg.textContent).toBe('Renamed to B.');
    page.note('Could not rename.', true);
    vi.advanceTimersByTime(60_000);
    expect(msg.textContent).toBe('Could not rename.');
  });

  it('gives the same line shown again its own full time', () => {
    const msg = element('order-msg');
    const page = pageWith(msg, element());
    page.note('Renamed to A.', false);
    vi.advanceTimersByTime(4000);
    page.note('Renamed to A.', false);
    vi.advanceTimersByTime(4000);
    expect(msg.textContent).toBe('Renamed to A.');
  });

  it('lets the confirmation under the jobs list go too', () => {
    expect(PAGE).toContain("from the list.':'Nothing to remove.';fadeLater(msg);");
  });
});

describe('what a screen reader hears', () => {
  it('reads a line about the accounts once: only the hidden region is live', () => {
    expect(PAGE).toContain('<p id="order-msg" class="note warn"></p>');
    expect(PAGE).toContain('<div class="sr" id="announce" role="status"></div>');
  });

  it('reads the same line again when it is said again', () => {
    vi.useFakeTimers();
    try {
      const region = element('announce');
      const say = new Function('region', `var document={getElementById:function(){return region}};${cut('say')};return say;`)(region) as (t: string) => void;
      region.textContent = 'Renamed to A.';
      say('Renamed to A.');
      expect(region.textContent).toBe('');
      vi.advanceTimersByTime(0);
      expect(region.textContent).toBe('Renamed to A.');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('focus after renaming', () => {
  it('goes back to the menu button without a ring after a mouse click on Done or Cancel', () => {
    const button = element();
    pageWith(element('order-msg'), button).endRename('a', 'Renamed to A.', false, 'A', true, false);
    expect(button.focused).toBe(true);
    expect(button.classList.contains('quiet')).toBe(true);
    expect(PAGE).toContain('.more.quiet:focus-visible{outline:none}');
  });

  it('keeps the ring when the rename ended from the keyboard', () => {
    const button = element();
    pageWith(element('order-msg'), button).endRename('a', 'Renamed to A.', false, 'A', true, true);
    expect(button.focused).toBe(true);
    expect(button.classList.contains('quiet')).toBe(false);
  });

  it('treats only a click started by a pointer as one without a ring', () => {
    expect(PAGE).toContain("[ok,no].forEach(function(b){b.addEventListener('pointerdown',byPointer);b.addEventListener('keydown',byKey)});");
    expect(PAGE).toContain("ok.addEventListener('click',function(){var k=!pointer;pointer=false;if(!busy)save(true,k)});");
    expect(PAGE).toContain("no.addEventListener('click',function(){var k=!pointer;pointer=false;cancel(k)});");
    expect(PAGE).not.toContain('e.detail===0');
    expect(PAGE).toContain("if(e.key==='Enter'&&e.target===box){e.preventDefault();save(true,true)}");
    expect(PAGE).toContain("else if(e.key==='Escape'){e.preventDefault();cancel(true)}");
  });

  it('brings the ring back with the first key press, and keeps a quiet button quiet through a redraw', () => {
    expect(PAGE).toContain("document.addEventListener('keydown',function(){var q=document.querySelector('.more.quiet');if(q)q.classList.remove('quiet')},true);");
    expect(PAGE).toContain("if(quiet)gs[k].classList.add('quiet');gs[k].focus({preventScroll:true})");
  });
});

describe('omnitrix dashboard in a terminal', () => {
  it("does not open the web browser from the Claude app's terminal, and says how to see the page there", () => {
    expect(dashboardOpening(true, false, { TERM_PROGRAM: 'claude-desktop' })).toEqual({ start: true, browser: false, paneHint: true });
    expect(paneHint('http://127.0.0.1:4590')).toContain("open Claude's browser pane and go to http://127.0.0.1:4590");
  });

  it('opens the web browser from any other terminal, as before', () => {
    expect(dashboardOpening(true, false, { TERM_PROGRAM: 'vscode' })).toEqual({ start: true, browser: true, paneHint: false });
    expect(dashboardOpening(true, false, {})).toEqual({ start: true, browser: true, paneHint: false });
  });

  it('opens nothing and gives no hint with --no-open, on CI or in tests', () => {
    for (const env of [{ TERM_PROGRAM: 'claude-desktop', CI: 'true' }, { OMNITRIX_NO_BROWSER: '1' }]) {
      expect(dashboardOpening(true, false, env)).toEqual({ start: true, browser: false, paneHint: false });
    }
    expect(dashboardOpening(false, false, { TERM_PROGRAM: 'claude-desktop' })).toEqual({ start: true, browser: false, paneHint: false });
    // after setup, with nobody to look, the dashboard is not started at all
    expect(dashboardOpening(false, true, {}).start).toBe(false);
    expect(dashboardOpening(true, true, { TERM_PROGRAM: 'claude-desktop' })).toEqual({ start: true, browser: false, paneHint: true });
  });
});
