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
