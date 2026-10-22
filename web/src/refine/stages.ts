/** The three steps of a new project's refinement, in order. */
export const STAGE_LABELS = {
  documents: 'Refinar documentos',
  backlog: 'Backlog',
  execution: 'Executar',
} as const;

export type StageKey = keyof typeof STAGE_LABELS;
export type StageState = 'todo' | 'active' | 'done';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
}

/** The one step the screen offers a new project now; `started` means the program runs and nothing is offered. */
export type StageAction = 'evaluate' | 'answer' | 'start' | 'started';

/** The part of the refinement state the stages read. */
export interface StageInput {
  status: string;
  stale: boolean;
  backlog?: { enabled: boolean; detail?: boolean | null; items: unknown[] } | null;
  questions?: ReadonlyArray<{ status: string; blocking: boolean }> | null;
}

/** The three steps: documents until ready, the backlog until every item is detailed and covered, then execution. Pure. */
export function stageOf(st: StageInput): Stage[] {
  const backlogOn = st.backlog?.enabled === true;
  const ready = st.status === 'ready' && !st.stale;
  const executionDone = st.status === 'started';
  const documentsDone = backlogOn || ready;
  const backlogDone = executionDone || (backlogOn && st.backlog?.detail === true && ready);
  const states: Record<StageKey, StageState> = {
    documents: documentsDone ? 'done' : 'active',
    backlog: backlogDone ? 'done' : documentsDone ? 'active' : 'todo',
    execution: executionDone ? 'done' : backlogDone ? 'active' : 'todo',
  };
  return (Object.keys(STAGE_LABELS) as StageKey[]).map((key) => ({ key, label: STAGE_LABELS[key], state: states[key] }));
}

/** The one step to offer now, so the buttons and the bar cannot disagree. */
export function stageAction(st: StageInput): StageAction {
  if (st.status === 'started') return 'started';
  const ready = st.status === 'ready' && !st.stale;
  if (ready && st.backlog?.enabled === true && st.backlog.detail === true) return 'start';
  if (st.questions?.some((q) => q.status === 'pending' && q.blocking)) return 'answer';
  return 'evaluate';
}

/** The name of the stage a running evaluation belongs to, for a new project. */
export function stageTitle(st: StageInput): string {
  return st.backlog?.enabled === true ? 'Avaliando o backlog' : 'Avaliando os documentos';
}
