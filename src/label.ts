// Account names as people write them: any language, emoji included, but nothing that hides or
// reverses text, breaks a terminal line or grows without end.

/** The longest name, counted in characters as people see them, so that one emoji counts as one. */
export const LABEL_MAX = 48;

// Kept although they are invisible format characters: the joiners that build emoji such as a family or
// a flag of a region, and that some scripts need, and the tag characters of those regional flags.
const KEEP = /^[‌‍\u{e0020}-\u{e007f}]$/u;
// Control and format characters (among them the marks that reverse the direction of text), line and
// paragraph separators, and lone halves of a character.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;
// Characters that show nothing by themselves: joiners, variation selectors, tag characters, fillers and the
// like, and space. A name made only of them would look empty.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\s]/gu;

const graphemes = (text: string): string[] => {
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment) : [...text];
};

/** Any text with the characters that a name may not hold made into spaces, without the other checks. */
export function cleanName(text: string): string {
  return text
    .normalize('NFC')
    .replace(UNSAFE, (ch) => (KEEP.test(ch) ? ch : ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A name made safe to keep and show, or the reason it cannot be one. Unsafe characters become spaces,
 * runs of space become one, and the ends are trimmed.
 */
export function checkLabel(text: unknown): { label: string } | { error: string } {
  if (typeof text !== 'string') return { error: 'a name must be text' };
  const clean = cleanName(text);
  if (!clean.replace(INVISIBLE, '')) return { error: 'a name needs at least one visible character' };
  const length = graphemes(clean).length;
  if (length > LABEL_MAX) return { error: `a name can have at most ${LABEL_MAX} characters; this one has ${length}` };
  return { label: clean };
}
