/**
 * Sections of the target project's docs, as backlog items cite them: markdown headings and numbered mermaid comments
 * (`%% 2. Checkout`, a common way to split a large mermaid flow). Browser-safe: the refinement screen matches
 * citations too.
 */
export interface DocSection {
  heading: string;
  /** The section's own lines, heading included. */
  text: string;
  /** The line the heading is on, counted from 0. */
  line: number;
}

/** The heading a follow-on request's section carries: "Pedido pedido-<n>". */
const REQUEST_HEADING = /^Pedido pedido-\d+$/;

/** Whether a heading is the one a follow-on request's section carries. */
export const isRequestHeading = (heading: string): boolean => REQUEST_HEADING.test(heading);

/**
 * The document without the sections of follow-on requests. A document without any is returned as it is, so its text keeps the
 * meaning it had: an added request leaves the plans of the items it does not touch as they are.
 */
export function withoutRequests(doc: string): string {
  const sections = docSections(doc);
  const requests = sections.filter((s) => REQUEST_HEADING.test(s.heading));
  if (requests.length === 0) return doc;
  const lines = doc.split(/\r?\n/);
  const starts = sections.map((s) => s.line);
  const dropped = new Set<number>();
  for (const s of requests) for (let i = s.line, end = starts.find((l) => l > s.line) ?? lines.length; i < end; i++) dropped.add(i);
  return lines.filter((_, i) => !dropped.has(i)).join('\n');
}

/** Whether a change's find lies inside the section that has `heading`: a change of the text under that heading. */
export function changesSection(doc: string, heading: string, find: string): boolean {
  if (find === '') return false;
  return docSections(doc).some((s) => s.heading === heading && s.text.includes(find));
}

const NUMBERED = /^%%\s*(\d+\.\s+\S.*?)\s*$/;
const MARKDOWN = /^(#{1,6})\s+(\S.*?)\s*$/;
const FENCE = /^\s*```/;

export const normHeading = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** R11.11: `flow.md` must be a mermaid diagram (the template already is): a mermaid fence with a body, closed by its own fence. */
export function flowIsMermaid(flow: string): boolean {
  const fenced = /^\s*```\s*mermaid\b[^\n]*\n([\s\S]*?)^\s*```\s*$/im.exec(flow);
  return fenced !== null && fenced[1]!.trim() !== '';
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
    return { heading: s.heading, text: lines.slice(s.line, end).join('\n'), line: s.line };
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

/** A section with nothing but blank lines between its heading and its first sub-section. */
function isContainer(text: string): boolean {
  const subs = docSections(text).slice(1);
  return subs.length > 0 && text.slice(text.indexOf('\n') + 1, text.indexOf(subs[0]!.text)).trim() === '';
}

/**
 * R11.10: when the section a citation names holds only sub-sections, the widest ones an item can cite instead, approvals
 * aside, so a change to one re-derives only the items citing it; null when the section has text of its own or none to cite.
 */
export function onlySubsections(doc: string, heading: string): string[] | null {
  const text = sectionText(doc, heading);
  if (text === null || !isContainer(text)) return null;
  const citable: DocSection[] = [];
  for (const s of docSections(text).slice(1)) {
    if (!isContainer(s.text) && !approvalKey(s.heading) && !citable.some((c) => c.text.includes(s.text))) citable.push(s);
  }
  return citable.length > 0 ? citable.map((s) => s.heading) : null;
}

/** R11.7.4: the owner approves an adjustment with a section headed `Approved adjustment: <key>-adjustment-<n>` (or the earlier `Ajuste aprovado:`). */
const APPROVAL = /^(?:Approved adjustment|Ajuste aprovado):\s*`?([a-z0-9]+(?:-[a-z0-9]+)*-(?:adjustment|ajuste)-\d+)`?$/i;

/** The adjustment key a section heading approves, or null. */
export const approvalKey = (heading: string): string | null => APPROVAL.exec(heading)?.[1]!.toLowerCase() ?? null;

/** The text of the section that approves `key`, under either spelling of its heading, or null. */
export const approvalText = (doc: string, key: string): string | null => docSections(doc).find((s) => approvalKey(s.heading) === key)?.text ?? null;

/** The doc without its approval sections, so an approval leaves the text of every other section as it was. */
export function withoutApprovals(doc: string): string {
  let out = doc;
  for (const { heading, text } of docSections(doc)) {
    if (approvalKey(heading)) out = out.includes(`\n${text}`) ? out.replace(`\n${text}`, '') : out.replace(text, '');
  }
  return out;
}

/** The longest part the graph reads before a section is cut again by its next heading level. */
const PART_CHARS = 20_000;

/**
 * The document cut into parts for the graph: one per level-2 section, and a part past PART_CHARS cut again by the next level.
 * Each part is named after its heading, so an unchanged section keeps its name and the graph reuses its extraction.
 */
export function graphParts(doc: string): Array<{ name: string; text: string }> {
  const parts: Array<{ name: string; text: string }> = [];
  const used = new Map<string, number>();
  const add = (key: string, text: string) => {
    const base = key || 'documento';
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    parts.push({ name: `${n > 1 ? `${base}-${n}` : base}.md`, text });
  };
  // A long section with no headings is cut after each code block, each piece named after its first line and carrying the section heading.
  const blocks = (lines: readonly string[], key: string, context: string) => {
    const heading = lines.find((l) => MARKDOWN.test(l));
    const groups: string[][] = [[]];
    let inCode = false;
    for (const line of lines) {
      groups.at(-1)!.push(line);
      if (!FENCE.test(line)) continue;
      inCode = !inCode;
      if (!inCode) groups.push([]);
    }
    groups.forEach((g, i) => {
      const first = g.find((l) => l.trim() !== '');
      if (!first) return;
      const name = `${key}--${normHeading(first).replace(/ /g, '-').slice(0, 60) || 'trecho'}`;
      add(name, (i > 0 && heading ? `${context}${heading}\n\n` : context) + g.join('\n'));
    });
  };
  const cut = (lines: readonly string[], level: number, key: string, context: string) => {
    const text = lines.join('\n');
    if (text.length <= PART_CHARS) return add(key, context + text);
    if (level > 6) return blocks(lines, key, context);
    const groups: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
    let inCode = false;
    for (const line of lines) {
      if (FENCE.test(line)) inCode = !inCode;
      const m = inCode ? null : MARKDOWN.exec(line);
      if (m && m[1]!.length === level) groups.push({ heading: m[2]!, lines: [] });
      groups.at(-1)!.lines.push(line);
    }
    if (groups.length === 1) return cut(lines, level + 1, key, context);
    // A subsection carries the heading of the section it belongs to.
    const parent = lines.find((l) => MARKDOWN.test(l) && MARKDOWN.exec(l)![1]!.length < level);
    for (const g of groups) {
      if (g.lines.join('').trim() === '') continue;
      const own = g.heading === null ? 'inicio' : normHeading(g.heading).replace(/ /g, '-').slice(0, 60) || 'secao';
      cut(g.lines, level + 1, key === '' ? own : `${key}--${own}`, g.heading !== null && parent && level > 2 ? `${context}${parent}\n\n` : context);
    }
  };
  cut(doc.split(/\r?\n/), 2, '', '');
  return parts;
}
