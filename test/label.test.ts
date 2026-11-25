import { describe, expect, it } from 'vitest';
import { checkLabel, LABEL_MAX } from '../src/label.js';

const ok = (text: string) => {
  const r = checkLabel(text);
  if ('error' in r) throw new Error(r.error);
  return r.label;
};

describe('account names', () => {
  it('keeps emoji of every kind whole', () => {
    expect(ok('🚀 Fast Gemini')).toBe('🚀 Fast Gemini');
    // a family (joined with zero-width joiners), a skin tone, a keycap and a flag of a region
    for (const e of ['👨‍👩‍👧‍👦', '👍🏽', '1️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🇮🇳', '❤️‍🔥']) expect(ok(`My ${e} key`)).toBe(`My ${e} key`);
  });

  it('keeps names in any language', () => {
    for (const name of ['محمد هاشم', 'ハシムのGemini', 'Ñandú Ölçü', 'हाशिम का खाता', 'می‌خواهم']) expect(ok(name)).toBe(name);
  });

  it('removes characters that hide, reverse or break text', () => {
    // a right-to-left override would show "exe.txt" as "txt.exe"
    expect(ok('safe‮txt.exe')).toBe('safe txt.exe');
    expect(ok('a\u0000b\u001b[31mc')).toBe('a b [31mc');
    expect(ok('line\nbreak\r\nand more')).toBe('line break and more');
    expect(ok('zero​width')).toBe('zero width');
    expect(ok('half \ud83d surrogate')).toBe('half surrogate');
  });

  it('joins spaces and trims the ends', () => {
    expect(ok('   My    ChatGPT\t\tPlus  ')).toBe('My ChatGPT Plus');
  });

  it('writes the same name the same way', () => {
    // é as one character and as e with an accent mark
    expect(ok('Café')).toBe(ok('Café'));
  });

  it('refuses an empty or invisible name', () => {
    // also a variation selector, a grapheme joiner and Hangul fillers alone, which show nothing either
    for (const text of ['', '   ', '‍‍', '️', '‮', '︀', '͏', 'ㅤㅤ', 'ᅟ']) expect(checkLabel(text)).toEqual({ error: 'a name needs at least one visible character' });
    expect(checkLabel(42)).toEqual({ error: 'a name must be text' });
  });

  it('counts characters as people see them, so emoji do not shorten the limit', () => {
    expect(ok('👨‍👩‍👧‍👦'.repeat(LABEL_MAX))).toHaveLength('👨‍👩‍👧‍👦'.length * LABEL_MAX);
    expect(checkLabel('x'.repeat(LABEL_MAX + 1))).toEqual({ error: `a name can have at most ${LABEL_MAX} characters; this one has ${LABEL_MAX + 1}` });
  });
});
