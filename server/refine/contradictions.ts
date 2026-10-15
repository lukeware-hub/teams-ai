import type { Contradiction } from '../agents/outputs.js';
import type { Divergence, DivergenceSide } from './checklist.js';
import { docSections, normHeading } from './sections.js';

/** Document texts by file name, as the refinement cycle keeps them (`brief.md` is the briefing). */
export type DocTexts = Record<string, string>;

const MIN_WORDS = 2;

/** The file the agent meant: its base name, with the briefing under the name the cycle uses. */
function fileOf(file: string, docs: DocTexts): string | null {
  const base = file.split(/[\\/]/).pop()!.toLowerCase();
  const name = base === 'briefing.md' ? 'brief.md' : base;
  return Object.hasOwn(docs, name) ? name : null;
}

/** Finds the quote in its document and names the innermost section holding it; null when the quote is not there. */
function locate(docs: DocTexts, side: { file: string; quote: string }): DivergenceSide | null {
  const file = fileOf(side.file, docs);
  const words = normHeading(side.quote);
  if (file === null || words.split(' ').length < MIN_WORDS) return null;
  const holds = (text: string) => ` ${normHeading(text)} `.includes(` ${words} `);
  if (!holds(docs[file]!)) return null;
  const innermost = docSections(docs[file]!).filter((s) => holds(s.text)).sort((x, y) => x.text.length - y.text.length)[0];
  return { file, heading: innermost?.heading ?? null, quote: side.quote };
}

/** Keeps the contradictions whose two quotes both appear in the documents, each side located to its section. */
export function verifyContradictions(docs: DocTexts, contradictions: readonly Contradiction[]): { verified: Divergence[]; dropped: Contradiction[] } {
  const verified: Divergence[] = [];
  const dropped: Contradiction[] = [];
  for (const c of contradictions) {
    const a = locate(docs, c.a);
    const b = locate(docs, c.b);
    if (a && b && normHeading(a.quote) !== normHeading(b.quote)) verified.push({ fact: c.fact, a, b, fix: c.fix });
    else dropped.push(c);
  }
  return { verified, dropped };
}
