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

/** Whether replacing `find` with `replace` adds or removes any structure, counted with repeats: a duplicated item is a change too. */
export function patchChangesScope(find: string, replace: string): boolean {
  const count = (items: string[]) => items.reduce((m, item) => m.set(item, (m.get(item) ?? 0) + 1), new Map<string, number>());
  const before = count(structureOf(find));
  const after = count(structureOf(replace));
  return [...new Set([...before.keys(), ...after.keys()])].some((key) => (before.get(key) ?? 0) !== (after.get(key) ?? 0));
}
