import { outlineDiff } from '@server/refine/outline-diff';
import type { RefineState, RequestImpact, RequestTrace } from '../api.js';
import type { StepperStep } from '../components/Stepper.js';

/** The specs whose run began: a request does not change them, it only adds around them. */
const STARTED = new Set(['running', 'paused:quota', 'paused:auth', 'awaiting-validation', 'done']);
const isStarted = (status: string | undefined): boolean => status !== undefined && STARTED.has(status);

/** The four steps of a request, in the order the owner reads them. */
export function requestNodes(st: RefineState): StepperStep[] {
  const planned = st.speckit?.status === 'done' && !st.speckit.stale;
  const steps = [
    { key: 'pedido', label: 'Pedido', done: true },
    { key: 'impacto', label: 'Impacto', done: st.impact?.impact != null },
    { key: 'specs', label: 'Specs e plano', done: planned && st.backlog?.detail === true },
    { key: 'pronto', label: 'Pronto', done: st.status === 'ready' && planned },
  ];
  const active = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({ key: s.key, label: s.label, state: s.done ? 'done' : i === active ? 'active' : 'todo' }));
}

/** The counts the impact card's chips show: the new specs of the replan, and what the SM found affected, documented and risky. */
export function impactCounts(impact: RequestImpact | null, added: number): { novas: number; afetadas: number; documentos: number; riscos: number } {
  return {
    novas: added,
    afetadas: impact?.affected.filter((a) => a.kind === 'spec').length ?? 0,
    documentos: impact?.affected.filter((a) => a.kind === 'doc').length ?? 0,
    riscos: impact?.risks.length ?? 0,
  };
}

export interface ReplanRow {
  key: string;
  title: string;
  state: string;
  oldRank: number | null;
  newRank: number;
  change: string;
}

const stateOf = (status: string | undefined): string => {
  if (status === 'done') return 'entregue';
  if (status === 'awaiting-validation') return 'aguarda validação';
  if (isStarted(status)) return 'em execução';
  if (status === 'planned') return 'planejada';
  return 'refinando';
};

/** Each item of the backlog as the request leaves it, read against the outline the request followed. */
export function replanRows(st: RefineState): ReplanRow[] {
  const items = [...(st.backlog?.items ?? [])].sort((a, b) => a.rank - b.rank);
  const before = st.extension?.before ?? [];
  const started = new Set(items.filter((i) => isStarted(st.backlog?.specs?.[i.key]?.spec?.status)).map((i) => i.key));
  const diff = outlineDiff(before, items.map((i) => ({ key: i.key, rank: i.rank, dependsOn: i.dependsOn })), started);
  const moved = new Map(diff.moved.map((m) => [m.key, m]));
  const rewired = new Set(diff.dependencies.map((d) => d.key));
  const added = new Set(diff.added);
  return items.map((i) => {
    const old = before.find((b) => b.key === i.key);
    const move = moved.get(i.key);
    const parts = added.has(i.key) ? ['nova'] : started.has(i.key) ? ['mantida'] : [];
    if (move) parts.push(`${move.to > move.from ? 'desceu' : 'subiu'} ${Math.abs(move.to - move.from)}`);
    if (rewired.has(i.key)) parts.push(`depende de ${i.dependsOn.join(', ')}`);
    return {
      key: i.key,
      title: i.title,
      state: added.has(i.key) ? 'nova' : stateOf(st.backlog?.specs?.[i.key]?.spec?.status),
      oldRank: old?.rank ?? null,
      newRank: i.rank,
      change: parts.length > 0 ? parts.join(' · ') : 'sem mudança',
    };
  });
}

export interface ReadyCheck {
  id: 'impacto' | 'specs' | 'planos' | 'perguntas';
  label: string;
  ok: boolean;
}

/** The checks the request's "Pronto" bar shows; "Iniciar" waits for the owner whatever they say. */
export function readyChecks(st: RefineState, specsApproved: boolean): ReadyCheck[] {
  const planned = st.speckit?.status === 'done' && !st.speckit.stale;
  return [
    { id: 'impacto', label: 'impacto', ok: st.impact?.impact != null && st.impact.issues.length === 0 },
    { id: 'specs', label: 'specs validadas', ok: specsApproved },
    { id: 'planos', label: 'planos', ok: planned },
    { id: 'perguntas', label: 'sem pergunta aberta', ok: !st.questions.some((q) => q.status === 'pending' && q.blocking) },
  ];
}

/** The trail the bar shows: what the request made, from its specs to their plans and their task lists. */
export function requestTrail(trace: RequestTrace | null | undefined, specs: number): string {
  const planned = trace?.specs.filter((s) => s.planned).length ?? 0;
  const tasked = trace?.specs.filter((s) => s.tasked).length ?? 0;
  return `Pedido → ${specs} specs → ${planned} planos → ${tasked} tarefas`;
}
