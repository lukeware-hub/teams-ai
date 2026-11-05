/** Lowercase, without accents, one space between words: the form every structure is compared in. */
const normal = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * What a document says about what gets built: its headings, list items, acceptance criterion ids, priorities and dependency lines.
 * A change that adds or removes one of these changes the scope, whatever its wording.
 */
export function structureOf(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) found.push(`heading:${normal(heading[1]!)}`);
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
    if (item) found.push(`item:${normal(item[1]!)}`);
    if (/\b(depende de|dependsOn|depends on)\b/i.test(line)) found.push(`dependency:${normal(line)}`);
    for (const match of line.matchAll(/\bAC-\d+\b/g)) found.push(`criterion:${match[0]}`);
    for (const match of line.matchAll(/\bP[0-3]\b/g)) found.push(`priority:${match[0]}`);
  }
  return found;
}

/** Counts each item of a list, repeats included. */
const tally = (items: string[]): Map<string, number> => items.reduce((m, item) => m.set(item, (m.get(item) ?? 0) + 1), new Map<string, number>());

/** Whether replacing `find` with `replace` adds or removes any structure, counted with repeats: a duplicated item is a change too. */
export function patchChangesScope(find: string, replace: string): boolean {
  const before = tally(structureOf(find));
  const after = tally(structureOf(replace));
  return [...new Set([...before.keys(), ...after.keys()])].some((key) => (before.get(key) ?? 0) !== (after.get(key) ?? 0));
}

/** One flow edge rerouted through new nodes: every end of the edge it finds stays in the replacement. */
export function reroutesEdge(find: string, replace: string): boolean {
  if (!find.includes('-->') || find.includes('\n')) return false;
  const ends = find.replace(/\|[^|]*\|/g, '').split('-->').map((side) => /^[A-Za-z]\w*/.exec(side.trim())?.[0]);
  return ends.every((id) => id !== undefined && new RegExp(`\\b${id}\\b`).test(replace));
}

/** A change that only adds to the text it finds: the find stays whole in the replacement (a clause joined by a comma may take the place of its final mark), and no structure of it is lost. */
export function additiveOnly(find: string, replace: string): boolean {
  const bare = find.replace(/[.:;]+$/, '');
  if (!replace.includes(find) && !(bare !== find && replace.includes(`${bare},`))) return false;
  const before = tally(structureOf(find));
  const after = tally(structureOf(replace));
  return [...before.keys()].every((key) => (after.get(key) ?? 0) >= (before.get(key) ?? 0));
}

/** A line as a change is compared: its words, without list and heading marks, stars, a final punctuation mark or an orchestrator id. */
const CITATION = /(,?\s*conforme\b[^,]*?)?\s*\(?\b(?:po|sm|front)-[cs]\d+-\d+\)?$/;
const contentLine = (line: string): string =>
  normal(line)
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\*/g, '')
    .replace(/[.;:,]+$/, '')
    .replace(CITATION, '')
    .trim();
const contentLines = (text: string): string[] => text.split('\n').map(contentLine).filter((line) => line !== '');

/**
 * Whether a change from `before` to `after` says nothing new: a change of form only, or lines the document already holds
 * (a second copy, or a citation that restates a line), where every line it drops is carried by a line it adds.
 */
export function changesNothing(before: string, after: string): boolean {
  const was = contentLines(before);
  const now = contentLines(after);
  if (was.join('\n') === now.join('\n')) return true;
  const had = tally(was);
  const holds = tally(now);
  const added = [...holds.keys()].filter((line) => holds.get(line)! > (had.get(line) ?? 0));
  const removed = [...had.keys()].filter((line) => had.get(line)! > (holds.get(line) ?? 0));
  if (added.length + removed.length === 0) return false;
  return added.every((line) => had.has(line)) && removed.every((line) => added.some((a) => a.includes(line)));
}

/** An orchestrator id as an agent cites it: a question, a patch or a decision of one cycle or round, such as po-c3-0 or sm-s4-0. */
const ORCHESTRATOR_ID = /\b(?:po|sm|front)-[cs]\d+-\d+\b/g;

/** Whether the replacement writes an orchestrator id into the document, one that the text it replaces did not hold. */
export function writesOrchestratorId(find: string, replace: string): boolean {
  const held = new Set(find.match(ORCHESTRATOR_ID) ?? []);
  return (replace.match(ORCHESTRATOR_ID) ?? []).some((id) => !held.has(id));
}

/** A list item line that carries a second item after a sentence end, such as "- Testes. - Docker": two items on one line. */
const JOINED_ITEMS = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+.*[.;][ \t]+[-*+][ \t]+\S/m;

/** Whether the replacement joins two list items on one line, which the text it replaces did not do. */
export const joinsListItems = (find: string, replace: string): boolean => JOINED_ITEMS.test(replace) && !JOINED_ITEMS.test(find);
