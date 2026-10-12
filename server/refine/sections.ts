/**
 * Sections of the target project's docs, as backlog items cite them: markdown headings and numbered mermaid comments
 * (`%% 2. Checkout`, a common way to split a large mermaid flow). Browser-safe: the refinement screen matches
 * citations too.
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

/** R11.11: `flow.md` must be a mermaid diagram (the template already is); a plain-markdown flow has no diagram to read numbered sections from. */
export function flowIsMermaid(flow: string): boolean {
  return /^\s*```\s*mermaid\b/im.test(flow);
}

/** A heading as its section number (when it starts with one) and its words. */
function parts(s: string): { number: string | null; words: string[] } {
  const tokens = normHeading(s).split(' ').filter((t) => t !== '');
  return /^\d+$/.test(tokens[0] ?? '') ? { number: tokens[0]!, words: tokens.slice(1) } : { number: null, words: tokens };
}
const within = (big: readonly string[], small: readonly string[]) => small.every((t) => big.includes(t));

/**
 * A cited heading matches a doc heading by whole words, never part of one, and numbered headings only match the same
 * number: "1. Caso" never matches "11. Caso clínico". A citation may abbreviate a heading ("Checkout" for "2. Checkout"); it
 * may say more than the heading only when both are numbered alike or neither is, so "Pagamento do caso" never stands
 * for "3. Pagamento". Under three characters a citation matches nothing.
 */
export function headingMatches(cited: string, heading: string): boolean {
  if (normHeading(cited).length < 3) return false;
  const a = parts(cited);
  const b = parts(heading);
  if (a.number !== null && b.number !== null && a.number !== b.number) return false;
  if (a.words.length === 0 || b.words.length === 0) return a.number !== null && a.number === b.number;
  const oneSideNumbered = (a.number === null) !== (b.number === null);
  return within(b.words, a.words) || (!oneSideNumbered && within(a.words, b.words));
}

/** How well a heading answers a citation: the same heading, then the same words, then the most words in common; null when it does not match. */
function score(cited: string, heading: string): number | null {
  if (normHeading(cited) === normHeading(heading)) return 3_000;
  const a = parts(cited);
  const b = parts(heading);
  if (a.words.length > 0 && (a.number === null || a.number === b.number) && a.words.join(' ') === b.words.join(' ')) return 2_000;
  if (!headingMatches(cited, heading)) return null;
  return 1_000 + a.words.filter((w) => b.words.includes(w)).length;
}

/** The one heading a citation names among `headings`, the closest on a tie, or null: a citation covers one section only. */
export function resolveHeading(cited: string, headings: readonly string[]): string | null {
  let best: { heading: string; score: number } | null = null;
  for (const heading of headings) {
    const s = score(cited, heading);
    if (s !== null && (!best || s > best.score || (s === best.score && parts(heading).words.length < parts(best.heading).words.length))) best = { heading, score: s };
  }
  return best?.heading ?? null;
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
 * The text of the section a citation names: the same heading, else the same words under any section number ("Checkout" for
 * "2. Checkout"), else the one with the most words in common and, on a tie, the smallest, so a broad heading never stands
 * in for a precise one. Null if none.
 */
export function sectionText(doc: string, heading: string): string | null {
  let best: { section: DocSection; score: number } | null = null;
  for (const section of docSections(doc)) {
    const s = score(heading, section.heading);
    if (s !== null && (!best || s > best.score || (s === best.score && section.text.length < best.section.text.length))) best = { section, score: s };
  }
  return best?.section.text ?? null;
}

/** R11.7.4: the owner approves an adjustment with a section headed `Ajuste aprovado: <key>-ajuste-<n>`. */
const APPROVAL = /^Ajuste aprovado:\s*`?([a-z0-9]+(?:-[a-z0-9]+)*-ajuste-\d+)`?$/i;

/** The adjustment key a section heading approves, or null. */
export const approvalKey = (heading: string): string | null => APPROVAL.exec(heading)?.[1]!.toLowerCase() ?? null;

/** The doc without its approval sections, so an approval leaves the text of every other section as it was. */
export function withoutApprovals(doc: string): string {
  let out = doc;
  for (const { heading, text } of docSections(doc)) {
    if (approvalKey(heading)) out = out.includes(`\n${text}`) ? out.replace(`\n${text}`, '') : out.replace(text, '');
  }
  return out;
}
