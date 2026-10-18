/** The three steps of a new project's refinement, in order. */
export const STAGE_LABELS = {
  documents: 'Refinar documentos',
  backlog: 'Quebrar o backlog',
  execution: 'Executar',
} as const;

export type StageKey = keyof typeof STAGE_LABELS;
export type StageState = 'todo' | 'active' | 'done';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
  note: string;
}

/** The part of the refinement state the stage bar reads. */
export interface StageInput {
  status: string;
  stale: boolean;
  backlog?: { enabled: boolean; detail?: boolean | null; items: unknown[] } | null;
}

/**
 * The three stages of a new project: documents until ready, the backlog (mandatory) until every item is detailed and covered,
 * then execution once the program has started. Pure: the screen derives everything from the snapshot.
 */
export function stageOf(st: StageInput, busy: boolean): Stage[] {
  const backlog = st.backlog ?? null;
  const executionDone = st.status === 'started';
  const documentsDone = backlog?.enabled === true || (st.status === 'ready' && !st.stale);
  const backlogDone = executionDone || (backlog?.enabled === true && backlog.detail === true && st.status === 'ready' && !st.stale);
  const backlogNote = busy
    ? 'Em andamento.'
    : backlog?.enabled !== true
      ? 'Clique em Quebrar o backlog para começar.'
      : st.status === 'answering'
        ? 'Responda às perguntas em aberto para continuar.'
        : st.stale
          ? 'Os documentos mudaram: clique em Continuar etapa 2.'
          : backlog.detail !== true
            ? 'Esboçando o backlog.'
            : 'Detalhando as specs.';
  const states: Record<StageKey, { state: StageState; note: string }> = {
    documents: documentsDone
      ? { state: 'done', note: 'Documentos prontos.' }
      : { state: 'active', note: 'Revise os documentos e avalie até ficar pronto.' },
    backlog: backlogDone
      ? { state: 'done', note: 'Backlog pronto.' }
      : documentsDone
        ? { state: 'active', note: backlogNote }
        : { state: 'todo', note: 'Depois da etapa 1.' },
    execution: executionDone
      ? { state: 'done', note: 'Execução iniciada.' }
      : backlogDone
        ? { state: 'active', note: 'Clique em Iniciar análise para começar.' }
        : { state: 'todo', note: 'Depois da etapa 2.' },
  };
  return (Object.keys(STAGE_LABELS) as StageKey[]).map((key) => ({ key, label: STAGE_LABELS[key], ...states[key] }));
}
