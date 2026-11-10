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
    { key: 'pedido', label: 'Pedido' },
    { key: 'impacto', label: 'Impacto' },
    { key: 'specs', label: 'Specs e plano' },
    { key: 'pronto', label: 'Pronto' },
  ];
  // The steps run in order: a step is done only once every step before it is, so a later one never reads done early.
  const doneFlags = [true, st.impact?.impact != null, planned && st.backlog?.detail === true, st.status === 'ready' && planned];
  const open = doneFlags.indexOf(false);
  return steps.map((s, i) => ({ key: s.key, label: s.label, state: open === -1 || i < open ? 'done' : i === open ? 'active' : 'todo' }));
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

/** The new specs are the requirements; the acceptance criteria of their ready specs are the business rules. */
export function understoodCounts(st: RefineState, added: string[]): { requirements: number; rules: number } {
  const rules = added.reduce((sum, key) => sum + (st.backlog?.specs?.[key]?.spec?.acceptanceCriteria.length ?? 0), 0);
  return { requirements: added.length, rules };
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
export function readyChecks(st: RefineState, specsReady: boolean, trace?: RequestTrace | null): ReadyCheck[] {
  const planned = st.speckit?.status === 'done' && !st.speckit.stale;
  // The plans check counts the specs the request made that have a task list too, as "planos e tarefas N/M".
  const made = trace?.specs.filter((s) => s.citesRequest) ?? [];
  const tasked = made.filter((s) => s.tasked).length;
  return [
    { id: 'impacto', label: 'impacto', ok: st.impact?.impact != null && st.impact.issues.length === 0 },
    { id: 'specs', label: 'specs geradas', ok: specsReady },
    { id: 'planos', label: made.length > 0 ? `planos e tarefas ${tasked}/${made.length}` : 'planos', ok: planned && tasked === made.length },
    { id: 'perguntas', label: 'sem pergunta aberta', ok: !st.questions.some((q) => q.status === 'pending' && q.blocking) },
  ];
}

/** The trail the bar shows: the specs the request made, and how many of them have a plan and a task list. */
export function requestTrail(trace: RequestTrace | null | undefined): string {
  const made = trace?.specs.filter((s) => s.citesRequest) ?? [];
  const planned = made.filter((s) => s.planned).length;
  const tasked = made.filter((s) => s.tasked).length;
  return `Pedido → ${made.length} ${made.length === 1 ? 'spec' : 'specs'} → ${planned} ${planned === 1 ? 'plano' : 'planos'} → ${tasked} ${tasked === 1 ? 'tarefa' : 'tarefas'}`;
}

/** The additions the team accepted on its own: the document each one changes and the section it adds to. */
export function acceptedAdditions(patches: ReadonlyArray<{ status: string; auto?: boolean; file: string; replace: string }>): Array<{ file: string; heading: string }> {
  return patches
    .filter((p) => p.status === 'accepted' && p.auto === true)
    .map((p) => ({ file: p.file, heading: p.replace.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? 'acréscimo' }));
}
