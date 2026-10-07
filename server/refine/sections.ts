/**
 * Sections of the target project's docs, as backlog items cite them: numbered mermaid comments (`%% 7. OPME`, the
 * Kayron flow.md style) and markdown headings. Browser-safe: the refinement screen matches citations too.
 */
export interface DocSection {
  heading: string;
  /** The section's own lines, heading included. */
  text: string;
}

const NUMBERED = /^%%\s*(\d+\.\s+\S.*?)\s*$/;
const MARKDOWN = /^(#{1,6})\s+(\S.*?)\s*$/;
const FENCE = /^\s*```/;

export const normHeading = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A heading as its section number (when it starts with one) and its words. */
function parts(s: string): { number: string | null; words: string[] } {
  const tokens = normHeading(s).split(' ').filter((t) => t !== '');
  return /^\d+$/.test(tokens[0] ?? '') ? { number: tokens[0]!, words: tokens.slice(1) } : { number: null, words: tokens };
}
const within = (big: readonly string[], small: readonly string[]) => small.every((t) => big.includes(t));

/**
 * A cited heading matches a doc heading when the words of one are all words of the other (whole words, never part of
 * one) and, when both are numbered, the numbers are equal: "1. Caso" never matches "11. Caso clínico". Under three
 * characters a citation matches nothing.
 */
export function headingMatches(cited: string, heading: string): boolean {
  if (normHeading(cited).length < 3) return false;
  const a = parts(cited);
  const b = parts(heading);
  if (a.number !== null && b.number !== null && a.number !== b.number) return false;
  if (a.words.length === 0 || b.words.length === 0) return a.number !== null && a.number === b.number;
  return within(b.words, a.words) || within(a.words, b.words);
}

/**
 * Every section in document order. A numbered mermaid section runs to the next numbered comment or the end of its
 * code block; a markdown section runs to the next heading of the same or a higher level outside code blocks.
 */
export function docSections(doc: string): DocSection[] {
  const lines = doc.split(/\r?\n/);
  const starts: Array<{ line: number; heading: string; level: number | 'numbered'; inCode: boolean }> = [];
  let inCode = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) inCode = !inCode;
    const numbered = NUMBERED.exec(line);
    const markdown = inCode ? null : MARKDOWN.exec(line);
    if (numbered) starts.push({ line: i, heading: numbered[1]!, level: 'numbered', inCode });
    else if (markdown) starts.push({ line: i, heading: markdown[2]!, level: markdown[1]!.length, inCode });
  });
  return starts.map((s) => {
    let end = lines.length;
    for (let i = s.line + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (s.level === 'numbered') {
        if (NUMBERED.test(line) || (s.inCode && FENCE.test(line))) { end = i; break; }
      } else {
        const next = starts.find((o) => o.line === i && o.level !== 'numbered');
        if (next && (next.level as number) <= s.level) { end = i; break; }
      }
    }
    return { heading: s.heading, text: lines.slice(s.line, end).join('\n') };
  });
}

/**
 * The text of the section a citation names: the same heading, else the same words under any section number ("OPME" for
 * "7. OPME"), else the smallest section that matches, so a broad heading never stands in for a precise one. Null if none.
 */
export function sectionText(doc: string, heading: string): string | null {
  const sections = docSections(doc);
  const exact = sections.find((s) => normHeading(s.heading) === normHeading(heading));
  if (exact) return exact.text;
  const cited = parts(heading);
  const sameWords = sections.find((s) => {
    const p = parts(s.heading);
    return (cited.number === null || cited.number === p.number) && p.words.join(' ') === cited.words.join(' ') && cited.words.length > 0;
  });
  if (sameWords) return sameWords.text;
  const matches = sections.filter((s) => headingMatches(heading, s.heading)).sort((x, y) => x.text.length - y.text.length);
  return matches[0]?.text ?? null;
}
