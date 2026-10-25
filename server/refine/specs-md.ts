import type { BacklogItem } from '../contracts/backlog.js';
import { buildSpecsIndex } from './specs-index.js';
import type { BacklogState } from './state.js';

/** The scope, reason and sources of one backlog item, as bullet lines (shared with backlog.md). */
export const itemLines = (i: Pick<BacklogItem, 'scope' | 'rationale' | 'sources'>): string[] => [
  `- Escopo: ${i.scope}`,
  `- Por quê: ${i.rationale}`,
  `- Origem: ${i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}`,
];

/** The specs index as Markdown, in rank order, with each item's criteria and pre-plan (browser-safe). */
export function renderSpecsMd(specId: string, backlog: Pick<BacklogState, 'epics' | 'items' | 'keyIds' | 'specs' | 'preplans'>): string {
  const index = buildSpecsIndex(specId, backlog);
  if (index.specs.length === 0) return '';
  const epicTitle = new Map(backlog.epics.map((e) => [e.key, e.title]));
  const parts = ['# Specs', '', '> Gerado a partir do backlog detalhado; não edite.', ''];
  for (const entry of index.specs) {
    const item = backlog.items.find((i) => i.key === entry.key)!;
    const meta = `- Épico: ${epicTitle.get(item.epic) ?? item.epic} · Prioridade: ${item.priority} · Tamanho: ${item.size} · Depende de: ${item.dependsOn.join(', ') || '-'}`;
    parts.push(`## ${item.key}: ${item.title}`, '', meta, ...itemLines(item), '');
    const criteria = backlog.specs?.[item.key]?.spec?.acceptanceCriteria ?? [];
    if (criteria.length > 0) parts.push('### Critérios de aceite', '', ...criteria.map((c) => `- ${c.id}: Dado ${c.given}, quando ${c.when}, então ${c.then}`), '');
    const tasks = backlog.preplans?.[item.key]?.preplan?.tasks ?? [];
    if (tasks.length > 0) parts.push('### Pré-plano', '', ...tasks.map((t) => `- ${t.id} [${t.module}, ${t.owner}] ${t.title} (${t.criteriaRefs.join(', ')})`), '');
  }
  return parts.join('\n');
}
