import { armsConclusive, MIN_ARM_SPECS, MIN_ARM_STEPS } from '@server/api/graph-experiment.js';
import type { GraphView } from '../../api.js';

export { MIN_ARM_SPECS, MIN_ARM_STEPS };

export type Verdict = 'ok' | 'degraded' | 'nodata';

export interface Health {
  verdict: Verdict;
  reason: string;
}

const HOUR_MS = 3_600_000;
const STALE_MS = 2 * HOUR_MS;
/** Queries measured before an empty answer rate means anything. */
const MIN_MEASURED = 10;

/** How long ago, in the words of the screen: minutes up to an hour, hours up to a day, then days. */
export function ageOf(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 60) return `há ${Math.max(1, minutes)} min`;
  if (minutes < 24 * 60) return `há ${Math.round(minutes / 60)} h`;
  const days = Math.round(minutes / (24 * 60));
  return `há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

/** The measured answers: how many queries recorded their result and how many of them found nothing. */
const answers = (view: GraphView): { measured: number; empty: number } => ({ measured: view.usage.effect?.measured ?? 0, empty: view.usage.effect?.empty ?? 0 });

/** Whether the graph is helping, with the one reason that decides it; the first reason that fits wins, worst first. */
export function graphHealth(view: GraphView, now: number): Health {
  if (!view.available) return { verdict: 'nodata', reason: 'O grafo deste projeto ainda não foi construído.' };
  if (view.status?.failure) return { verdict: 'degraded', reason: 'A última atualização falhou; o grafo mostrado é o da versão anterior.' };
  const updatedAt = view.status?.updatedAt ?? null;
  if (updatedAt !== null && now - Date.parse(updatedAt) > STALE_MS) return { verdict: 'degraded', reason: `O grafo foi atualizado ${ageOf(updatedAt, now)}.` };
  const { measured, empty } = answers(view);
  if (measured >= MIN_MEASURED && empty / measured >= 0.5) return { verdict: 'degraded', reason: 'Metade ou mais das consultas voltou vazia.' };
  if ((view.specs ?? 0) > 0 && view.relations === undefined) return { verdict: 'degraded', reason: 'O grafo tem as specs, mas nenhuma ligação entre elas.' };
  const q = view.usage.queries;
  if (q.steps + q.refine.steps + q.chat.steps === 0) return { verdict: 'nodata', reason: 'Nenhum passo mediu consultas ao grafo ainda.' };
  const age = updatedAt === null ? '' : `Atualizado ${ageOf(updatedAt, now)}. `;
  return { verdict: 'ok', reason: `${age}${measured > 0 ? 'As consultas estão voltando com resposta.' : 'Os agentes já consultaram o grafo.'}` };
}

const RELATION_ORDER: ReadonlyArray<[string, string]> = [
  ['depends_on', 'depende de'],
  ['has_plan', 'plano'],
  ['has_tasks', 'tarefas'],
  ['belongs_to', 'serviço'],
  ['derived_from', 'origem'],
  ['touches', 'arquivos'],
  ['similar_failure', 'falhas parecidas'],
];

/** The links the specs and failures added, one count per relation, in a fixed order; a graph with none says so. */
export function relationsLine(relations: GraphView['relations']): string {
  const parts = RELATION_ORDER.filter(([key]) => (relations?.[key] ?? 0) > 0).map(([key, label]) => `${relations![key]} ${label}`);
  return parts.length === 0 ? 'nenhuma ligação' : parts.join(' · ');
}

/** The share of measured queries that found something, with how many were measured. */
export function usefulLine(view: GraphView): string {
  const { measured, empty } = answers(view);
  if (measured > 0) return `${Math.round(((measured - empty) / measured) * 100)}% de ${measured} consultas`;
  const total = view.usage.queries.total + view.usage.queries.refine.total + view.usage.queries.chat.total;
  return total > 0 ? `${total} consultas, ainda sem medir a resposta` : 'nenhuma consulta medida';
}

export interface ArmRow {
  kind: string;
  graph: { cost: number; reads: number; steps: number };
  control: { cost: number; reads: number; steps: number };
  /** Cost and reads with the graph against without it, as a share of the control's; negative means the graph spent less. Null while the control spends nothing. */
  costChange: number | null;
  readsChange: number | null;
  /** How many different specs each group has. */
  specs: { graph: number; control: number };
  /** False while a group has too few steps or too few specs for the comparison to mean anything. */
  conclusive: boolean;
}

const perStep = (spend: { steps: number; costUsd: number; reads: number }) => ({ cost: spend.steps === 0 ? 0 : spend.costUsd / spend.steps, reads: spend.steps === 0 ? 0 : spend.reads / spend.steps, steps: spend.steps });
const change = (graph: number, control: number): number | null => (control > 0 ? ((graph - control) / control) * 100 : null);

/** The experiment by step kind: what each arm spent per step, how the two differ, and whether there are steps enough to trust it. */
export function armRows(arms: NonNullable<GraphView['usage']['effect']>['arms'] | undefined): ArmRow[] {
  return Object.entries(arms ?? {})
    .map(([kind, { graph, control, specs }]) => {
      const [g, c] = [perStep(graph), perStep(control)];
      return { kind, graph: g, control: c, specs, conclusive: armsConclusive({ graph: g.steps, control: c.steps }, specs), costChange: change(g.cost, c.cost), readsChange: change(g.reads, c.reads) };
    })
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
}
