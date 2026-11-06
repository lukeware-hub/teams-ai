import { docSections, normHeading } from './sections.js';
import { MANAGED, shapeProblem } from './template-shape.js';
import { TEMPLATE, type SuggestFile } from './suggest.js';

/**
 * The words a section's title carries to fill a heading of its file's template. A section fills the heading whose words its title
 * holds; the heading's own name always counts.
 */
const WORDS: Partial<Record<SuggestFile, Record<string, string[]>>> = {
  'project.md': {
    Vision: ['visao', 'proposta de valor'],
    Personas: ['usuarios', 'atores', 'personas'],
    Constraints: ['restricoes', 'invariantes', 'regras de negocio'],
    Stack: ['stack', 'tecnologias'],
    Principles: ['principios'],
    'Deploy target': ['deploy', 'implantacao', 'infraestrutura'],
    'GitHub owner': ['github'],
  },
  'briefing.md': {
    Type: ['tipo'],
    Objectives: ['objetivos', 'objetivo'],
    Features: ['funcionalidades', 'requisitos'],
    'Acceptance criteria': ['criterios de aceitacao', 'criterios'],
    'Out of scope': ['fora de escopo', 'nao escopo'],
    'External dependencies': ['dependencias externas', 'dependencias'],
    'Bug details': ['detalhes do bug', 'bug'],
    Tasks: ['tarefas'],
  },
  'stack.md': {
    Runtime: ['runtime', 'linguagem', 'ambiente de execucao'],
    Frameworks: ['frameworks', 'bibliotecas'],
    Storage: ['storage', 'armazenamento', 'banco de dados'],
    Tooling: ['tooling', 'ferramentas', 'build', 'testes'],
  },
  'design.md': {
    'Brand and direction': ['marca', 'direcao', 'brand'],
    Foundations: ['fundamentos', 'foundations', 'tokens'],
    'Responsive composition': ['responsivo', 'responsive'],
    'Components and patterns': ['componentes', 'components'],
    'Interaction and motion': ['interacao', 'movimento', 'motion'],
    'Accessibility and content': ['acessibilidade', 'accessibility'],
    'Implementation contract': ['implementacao', 'contrato'],
  },
};

export type Layout = { ok: true; text: string } | { ok: false; reason: string };

const titleOf = (line: string): string | null => (line.startsWith('## ') ? line.slice(3).trim() : null);

/** The lines a layout may move but never change: text, not headings, blanks or the "(none)" mark. */
const content = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^#{1,6} /.test(line) && line !== '- (none)')
    .sort();

/** The subsections of a moved section one level lower, so the template's headings stay the only ones at the top. */
const demote = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      const m = /^(#{2,6}) /.exec(line);
      return m ? `${'#'.repeat(Math.min(6, m[1]!.length + 2))} ${line.slice(m[0].length)}` : line;
    })
    .join('\n');

const fills = (title: string, words: readonly string[]): boolean =>
  words.some((word) => {
    const w = normHeading(word);
    return title === w || ` ${title} `.includes(` ${w} `);
  });

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * The document in the layout of its template, by an algorithm and no rewriting: each section moves under the template heading its
 * title fills, the sections that fill none follow in their order, and the layout is refused unless the template's headings open
 * the text and every line of the text is still there.
 */
export function formatByTemplate(file: SuggestFile, doc: string, projectId: string): Layout {
  const lines = doc.split('\n');
  const starts = docSections(doc)
    .filter((s) => s.text.startsWith('## '))
    .map((s) => s.line);
  if (starts.length === 0) return { ok: false, reason: 'o documento não tem seções de nível 2' };
  const blocks = starts.map((from, i) => {
    const text = lines.slice(from, starts[i + 1] ?? lines.length).join('\n').trimEnd();
    const title = titleOf(text.split('\n')[0]!) ?? '';
    return { key: normHeading(title), text, used: false };
  });
  const preamble = lines.slice(0, starts[0]).join('\n').trimEnd();
  const out: string[] = preamble === '' ? [] : [preamble];
  for (const head of TEMPLATE[file](projectId).split('\n').flatMap((line) => titleOf(line) ?? [])) {
    const own = normHeading(head);
    const found = blocks.filter((b) => !b.used && !MANAGED.test(b.key) && fills(b.key, [head, ...(WORDS[file]?.[head] ?? [])]));
    for (const b of found) b.used = true;
    const bodies = found.map((b) => (b.key === own ? b.text.split('\n').slice(1).join('\n').trim() : demote(b.text))).filter((text) => text !== '');
    out.push(`## ${head}`, ...(bodies.length > 0 ? bodies : ['- (none)']));
  }
  for (const b of blocks) if (!b.used) out.push(b.text);
  const text = `${out.join('\n\n')}\n`;
  const problem = shapeProblem(file, text, doc, projectId);
  if (problem !== null) return { ok: false, reason: problem };
  if (!sameLines(content(doc), content(text))) return { ok: false, reason: 'a forma mudaria o texto do documento' };
  return { ok: true, text };
}
