type Work = { command: string; itemKey?: string; startedAt?: string; reused?: boolean };
type Check = { id: string; ok: boolean; detail: string };
type RowState = 'done' | 'current' | 'ahead' | 'problem';

export type ProgressRow = { id: string; label: string; state: RowState; value: string };
export type ProgressNow = { label: string; since?: string };

export type ProgressInput = {
  /** The backlog items the plans cover. */
  items: Array<{ key: string; title: string }>;
  /** Keys of the items that already have a validated spec. */
  detailed: string[];
  /** Finished plan and task-list steps, reused ones included. */
  steps: Work[];
  /** Plan and task-list steps running now. */
  running: Work[];
  /** Only a repository session writes a task list per item. */
  repositories: boolean;
  checks: Check[];
  architectureRunning: boolean;
  /** Every closing check passed. */
  closed: boolean;
};

const SHOWN = 4;
const FIXED = ['documents', 'architecture', 'dependencies', 'questions'];

/** How many distinct backlog items have a finished step of this command. */
const countDone = (steps: Work[], command: string, keys: Set<string>): number =>
  new Set(steps.filter((s) => s.command === command && s.itemKey && keys.has(s.itemKey)).map((s) => s.itemKey)).size;

/** Where the backlog stands towards a start: the percent done, one row per check, and what runs now. Real counts only. */
export function backlogProgress(input: ProgressInput) {
  const { items, steps, running, checks } = input;
  const keys = new Set(items.map((i) => i.key));
  const titles = new Map(items.map((i) => [i.key, i.title]));
  const check = (id: string) => checks.find((c) => c.id === id);
  const specs = input.detailed.filter((k) => keys.has(k)).length;
  const plans = countDone(steps, 'plan', keys);
  const tasks = input.repositories ? countDone(steps, 'tasks', keys) : 0;

  const fixedDone = FIXED.filter((id) => check(id)?.ok).length;
  const total = FIXED.length + items.length * (input.repositories ? 3 : 2);
  const done = fixedDone + specs + plans + tasks;
  // Never 100 before the closing says so.
  const percent = input.closed ? 100 : Math.min(99, Math.round((done / total) * 100));

  const counted = (id: string, label: string, n: number, kind?: string): ProgressRow => {
    const state: RowState = n >= items.length && items.length > 0 ? 'done' : kind && running.some((r) => r.command === kind) ? 'current' : 'ahead';
    return { id, label, state, value: `${n} de ${items.length}` };
  };
  const fromCheck = (id: string, label: string): ProgressRow => {
    const c = check(id);
    if (c?.ok) return { id, label, state: 'done', value: '' };
    if (id === 'architecture') return { id, label, state: input.architectureRunning ? 'current' : 'ahead', value: '' };
    return { id, label, state: c ? 'problem' : 'ahead', value: c ? 'precisa de revisão' : '' };
  };
  const rows: ProgressRow[] = [
    fromCheck('documents', 'Documentos'),
    counted('specs', 'Specs', specs),
    counted('plans', 'Planos', plans, 'plan'),
    ...(input.repositories ? [counted('tasks', 'Tarefas', tasks, 'tasks')] : []),
    fromCheck('architecture', 'Arquitetura'),
    fromCheck('dependencies', 'Dependências'),
    fromCheck('questions', 'Perguntas'),
  ];

  const now: ProgressNow[] = [
    ...(input.architectureRunning ? [{ label: 'Decidindo a arquitetura' }] : []),
    ...running.map((r): ProgressNow => {
      const what = r.command === 'tasks' ? 'Lista de tarefas' : 'Plano';
      const name = r.itemKey ? ` de ${titles.get(r.itemKey) ?? r.itemKey}` : '';
      return { label: `${what}${name}`, ...(r.startedAt ? { since: r.startedAt } : {}) };
    }),
  ];
  return { percent, done, total, rows, now: now.slice(0, SHOWN), more: Math.max(0, now.length - SHOWN) };
}
