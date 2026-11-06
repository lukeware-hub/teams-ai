import { estimateTokens } from '../knowledge/context-pack.js';
import { docSections } from './sections.js';

/** The size a review part may have, in estimated tokens. */
export const PART_TOKENS = 25_000;
/** The most parts one review may read; a longer document is refused with its count. */
export const MAX_STAGE_PARTS = 40;

type Range = [from: number, to: number];

/**
 * The lines of `doc` cut into consecutive parts of at most `maxTokens` estimated tokens, each cut on a heading when one fits.
 * Joining the parts with newlines gives the document back unchanged.
 */
export function stageParts(doc: string, maxTokens: number): string[] {
  const lines = doc.split('\n');
  const text = ([from, to]: Range) => lines.slice(from, to).join('\n');
  const fits = (range: Range) => estimateTokens(text(range)) <= maxTokens;
  // A run of lines too big for one part is cut between lines; a single line too big stays alone.
  const cutLines = ([from, to]: Range): Range[] => {
    const cut: Range[] = [];
    let start = from;
    for (let i = from + 1; i < to; i++) {
      if (!fits([start, i + 1])) {
        cut.push([start, i]);
        start = i;
      }
    }
    return [...cut, [start, to]];
  };
  const heads = [...new Set([0, ...docSections(doc).map((s) => s.line)])].sort((a, b) => a - b);
  const sections: Range[] = heads.map((from, i) => [from, heads[i + 1] ?? lines.length]);
  const pieces = sections.flatMap((section) => (fits(section) ? [section] : cutLines(section)));
  const parts: Range[] = [];
  for (const piece of pieces) {
    const last = parts.at(-1);
    if (last && fits([last[0], piece[1]])) last[1] = piece[1];
    else parts.push([...piece]);
  }
  return parts.map(text);
}
