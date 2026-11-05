import type { Impact } from '../contracts/impact.js';
import { FIVE_DOCS } from '../docs/layout.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { buildWithDocs, DIGEST_NOTE } from './docs-view.js';

/** One item of the outline the impact is read against. */
export interface ImpactItem {
  key: string;
  title: string;
  rank: number;
  dependsOn: readonly string[];
  /** A spec main already started: the request does not change it directly. */
  started: boolean;
  modules: readonly string[];
}

const IMPACT_RULES = [
  'IMPACT (mandatory): the owner made a request in a project already in development. Say what it changes in the backlog it follows, in Brazilian Portuguese.',
  '- affected: each spec, document, architecture decision or other decision the request touches, with the action (adjust, review or none). A started spec is never adjusted here.',
  '- conflicts: pairs of items that change the same code (the same module); name how the order resolves them.',
  '- duplicates: a new item that repeats a spec already in the backlog; verdict reuse when the existing one already delivers it, distinct otherwise.',
  '- dependencies: an item that cannot ship without another; never a cycle.',
  '- risks: what could break, its severity and its mitigation.',
  'Use only the keys and references of the outline below; never invent one.',
].join('\n');

/** The pack of the impact step: the request word for word, the five documents with its section whole, and the outline with what started. */
export function impactPack(input: { specHash: string; principles: readonly string[]; request: string; requestId: string; heading: string; docs: Partial<Record<'project.md' | 'briefing.md' | 'stack.md' | 'flow.md' | 'design.md', string>>; items: readonly ImpactItem[]; issues?: readonly string[] }): ContextPackInput {
  const outline = input.items.map((i) => `- ${i.key}: ${i.title}${i.started ? ' (started)' : ''}; rank ${i.rank}; depends on ${i.dependsOn.join(', ') || 'nothing'}; modules ${i.modules.join(', ') || 'none'}`).join('\n');
  const feedback = buildWithDocs({ project: input.docs['project.md'], brief: input.docs['briefing.md'], stack: input.docs['stack.md'], flow: input.docs['flow.md'], design: input.docs['design.md'] }, (d, digested) => [
    IMPACT_RULES,
    `The requestId of your output is "${input.requestId}", exactly.`,
    ...(input.issues?.length ? ['### Your last impact broke these rules, fix every point', input.issues.map((i) => `- ${i}`).join('\n')] : []),
    ...(digested ? [DIGEST_NOTE] : []),
    `### The request, word for word (its section of briefing.md is "${input.heading}")\n${input.request}`,
    `### Outline\n${outline}`,
    `### project.md\n${d.project}`,
    `### briefing.md\n${d.brief}`,
    `### stack.md\n${d.stack}`,
    `### flow.md (Mermaid)\n${d.flow}`,
    `### design.md\n${d.design}`,
  ].join('\n\n'), undefined, (h) => h === input.heading);
  return { kind: 'impact', role: 'sm', specHash: input.specHash, principles: input.principles, outputContract: outputContract('impact'), criteria: [], feedback, budgetTokens: 20_000 };
}

/**
 * The rules of an impact the agent cannot break: every reference names an item of the outline or of main, a dependency forms no
 * cycle, and no started spec is adjusted here. Returns the issues in plain words; none means the impact is usable.
 */
export function validateImpact(impact: Impact, scope: { known: ReadonlySet<string>; kept: ReadonlySet<string>; requestId?: string }): string[] {
  const issues: string[] = [];
  for (const a of impact.affected) {
    if (a.kind === 'spec' && !scope.known.has(a.ref)) issues.push(`o impacto cita a spec ${a.ref}, que o backlog não tem`);
    if (a.kind === 'spec' && a.action === 'adjust' && scope.kept.has(a.ref)) issues.push(`o item ${a.ref} já começou: o pedido não o ajusta direto, só por um ajuste aprovado`);
  }
  for (const d of impact.duplicates) {
    if (!scope.known.has(d.newKey)) issues.push(`a duplicidade cita o item ${d.newKey}, que o backlog não tem`);
    if (!scope.known.has(d.existing)) issues.push(`a duplicidade cita a spec existente ${d.existing}, que o backlog não tem`);
  }
  for (const c of impact.conflicts) {
    for (const k of [c.a, c.b]) if (!scope.known.has(k)) issues.push(`o conflito cita o item ${k}, que o backlog não tem`);
  }
  for (const d of impact.dependencies) {
    for (const k of [d.from, d.to]) if (!scope.known.has(k)) issues.push(`a dependência cita o item ${k}, que o backlog não tem`);
  }
  for (const a of impact.affected) {
    // A reference may name the folder ("docs/briefing.md") and a section after "›", "," or "(": the document is the name before them, and it must be one of the five.
    const doc = a.ref.trim().replace(/^docs\//, '').split(/\s*(?:›|,|\()/)[0]!.trim();
    if (a.kind === 'doc' && !(FIVE_DOCS as readonly string[]).includes(doc)) issues.push(`o impacto cita o documento ${a.ref}, que não é um dos cinco documentos`);
    if (a.kind === 'architecture' && a.ref !== 'architecture') issues.push(`o impacto cita a arquitetura como ${a.ref}; a arquitetura é uma só`);
  }
  if (impact.summary.split(/[.!?](?:\s|$)/).filter((sentence) => sentence.trim() !== '').length > 2) issues.push('o resumo do impacto tem mais de duas frases');
  if (scope.requestId !== undefined && impact.requestId !== scope.requestId) issues.push(`o impacto é do pedido ${impact.requestId}, não de ${scope.requestId}`);
  if (hasCycle(impact.dependencies)) issues.push('as dependências formam um ciclo: um item não pode depender de si mesmo, direta ou indiretamente');
  return issues;
}

/** Whether the dependencies (each from depends on to) form a cycle. */
function hasCycle(edges: ReadonlyArray<{ from: string; to: string }>): boolean {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const state = new Map<string, 'open' | 'done'>();
  const visit = (node: string): boolean => {
    if (state.get(node) === 'open') return true;
    if (state.get(node) === 'done') return false;
    state.set(node, 'open');
    const cyclic = (next.get(node) ?? []).some(visit);
    state.set(node, 'done');
    return cyclic;
  };
  return [...next.keys()].some(visit);
}
