import type { Spec } from '../contracts/spec.js';

const bullets = (items: readonly string[]): string[] => (items.length > 0 ? items.map((i) => `- ${i}`) : ['- Nenhum']);

/** One derived spec as Markdown: objectives, features, criteria, tasks and what stays out (browser-safe). */
export function renderSpecMd(spec: Spec): string {
  const parts = [`# Spec ${spec.specId}`, '', `Tipo: ${spec.type}`, '', '## Objetivos', '', ...bullets(spec.objectives), '', '## Funcionalidades', '', ...bullets(spec.features), ''];
  if (spec.bug) parts.push('## Bug', '', `- Comportamento atual: ${spec.bug.actual}`, `- Comportamento esperado: ${spec.bug.expected}`, `- Como reproduzir: ${spec.bug.reproduction}`, '');
  parts.push('## Critérios de aceite', '', ...spec.acceptanceCriteria.map((c) => `- ${c.id}: Dado ${c.given}, quando ${c.when}, então ${c.then}`), '');
  if (spec.tasks?.length) parts.push('## Tarefas', '', ...spec.tasks.map((t) => `- ${t.title}: ${t.description}`), '');
  parts.push('## Fora do escopo', '', ...bullets(spec.outOfScope), '');
  if (spec.externalDependencies.length > 0) parts.push('## Dependências externas', '', ...spec.externalDependencies.map((d) => `- ${d.name}: ${d.purpose}${d.secretNames.length > 0 ? ` (${d.secretNames.join(', ')})` : ''}`), '');
  return parts.join('\n');
}
