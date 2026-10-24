import { docSections, normHeading, type DocSection } from './sections.js';
import { TEMPLATE, type SuggestFile } from './suggest.js';

/** Sections the code writes; a reshape keeps them word for word. */
const MANAGED = /^(decisoes|decisions|ajuste aprovado)/;
const LEVEL = /^(#{1,6})\s/;

const levelOf = (section: DocSection): number => LEVEL.exec(section.text)?.[1]?.length ?? 0;

/** The level 2 and 3 headings of a document, in order, leaving out the sections the code manages. */
function shape(doc: string): string[] {
  let managed = false;
  const heads: string[] = [];
  for (const section of docSections(doc)) {
    const level = levelOf(section);
    if (level <= 2) managed = level === 2 && MANAGED.test(normHeading(section.heading));
    if (!managed && (level === 2 || level === 3)) heads.push(`${level} ${normHeading(section.heading)}`);
  }
  return heads;
}

/** The text of each managed section, subsections included. */
const managedBlocks = (doc: string): string[] =>
  docSections(doc).filter((s) => levelOf(s) === 2 && MANAGED.test(normHeading(s.heading))).map((s) => s.text.trim());

/** Whether a file holds nothing but the template: blank, or only lines the template has, its title aside. */
export function isUntouched(file: SuggestFile, text: string, projectId: string): boolean {
  const model = new Set(TEMPLATE[file](projectId).split('\n').map((line) => line.trim()));
  return text.split('\n').every((line) => line.trim() === '' || /^#\s/.test(line) || model.has(line.trim()));
}

/** The template's headings open the text, in their order; the sections the template lacks come after them. */
const opensWith = (heads: string[], model: string[]): boolean => model.every((head, i) => heads[i] === head);

/** Why `text` does not follow the template of `file`, in plain words; null when it does. `before` is the text it replaces. */
export function shapeProblem(file: SuggestFile, text: string, before: string, projectId: string): string | null {
  const template = TEMPLATE[file](projectId);
  if (text.trim() === '') return 'o texto ficou vazio';
  if (!opensWith(shape(text), shape(template))) return 'faltam seções do modelo ou elas estão fora de ordem';
  const placeholder = [...new Set(template.match(/<[^<>\n]+>/g) ?? [])].find((p) => text.includes(p));
  if (placeholder) return `ainda tem o texto do modelo: ${placeholder}`;
  if (managedBlocks(before).some((block) => !text.includes(block))) return 'mudou o texto de decisões já registradas';
  return null;
}
