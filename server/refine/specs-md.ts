import type { BacklogItem } from '../contracts/backlog.js';
import { buildSpecsIndex, type SpecsIndexEntry } from './specs-index.js';
import type { BacklogState } from './state.js';

/** The scope, reason and sources of one backlog item, as bullet lines (shared with backlog.md). */
export const itemLines = (i: Pick<BacklogItem, 'scope' | 'rationale' | 'sources'>): string[] => [
  `- Escopo: ${i.scope}`,
  `- Por quê: ${i.rationale}`,
  `- Origem: ${i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}`,
];

/** Specs in rank order; when some spec names a repository, each repository's specs together, in the order repositories first appear. */
function byRepository(specs: readonly SpecsIndexEntry[]): SpecsIndexEntry[] {
  if (!specs.some((s) => s.repository !== undefined)) return [...specs];
  return [...new Set(specs.map((s) => s.repository ?? ''))].flatMap((repo) => specs.filter((s) => (s.repository ?? '') === repo));
}

/** The specs index as Markdown, in rank order, with each item's criteria and pre-plan (browser-safe). */
export function renderSpecsMd(specId: string, backlog: Pick<BacklogState, 'epics' | 'items' | 'keyIds' | 'specs' | 'preplans'>): string {
  const index = buildSpecsIndex(specId, backlog);
  if (index.specs.length === 0) return '';
  const epicTitle = new Map(backlog.epics.map((e) => [e.key, e.title]));
  const parts = ['# Specs', '', '> Gerado a partir do backlog detalhado; não edite.', ''];
  let shownRepository: string | undefined;
  for (const entry of byRepository(index.specs)) {
    const item = backlog.items.find((i) => i.key === entry.key)!;
    if (entry.repository !== undefined && entry.repository !== shownRepository) parts.push(`# ${entry.repository}`, '');
    shownRepository = entry.repository;
    const repo = item.repository === undefined ? '' : ` · Repositório: ${item.repository}`;
    const meta = `- Épico: ${epicTitle.get(item.epic) ?? item.epic} · Prioridade: ${item.priority} · Tamanho: ${item.size} · Depende de: ${item.dependsOn.join(', ') || '-'}${repo}`;
    parts.push(`## ${item.key}: ${item.title}`, '', meta, ...itemLines(item), '');
    const criteria = backlog.specs?.[item.key]?.spec?.acceptanceCriteria ?? [];
    if (criteria.length > 0) parts.push('### Critérios de aceite', '', ...criteria.map((c) => `- ${c.id}: Dado ${c.given}, quando ${c.when}, então ${c.then}`), '');
    const tasks = backlog.preplans?.[item.key]?.preplan?.tasks ?? [];
    if (tasks.length > 0) parts.push('### Pré-plano', '', ...tasks.map((t) => `- ${t.id} [${t.module}, ${t.owner}] ${t.title} (${t.criteriaRefs.join(', ')})`), '');
  }
  return parts.join('\n');
}
