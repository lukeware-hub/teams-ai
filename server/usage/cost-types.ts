/** Where money goes: refining the documents, developing the specs, or asking the chat. */
export const COST_STAGES = ['refinement', 'development', 'chat'] as const;
export type CostStage = (typeof COST_STAGES)[number];

/** `hoje` is the current day in the server's time zone; `tudo` has no lower bound. */
export const COST_PERIODS = ['hoje', '7d', '30d', 'tudo'] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];

export interface CostTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One charge read from a journal, or one chat answer. `costUsd` is null when the call reported no cost. */
export interface CostFact {
  stage: CostStage;
  projectId: string | null;
  /** Development: the spec. Refinement: the draft, which is the spec id or `<projectId>-backlog` or `<projectId>-pedido-<n>`. */
  specId: string | null;
  runId: string | null;
  repository: string | null;
  taskId: string | null;
  attempt: number;
  phase: string;
  kind: string;
  /** The agent role, or null for a decision model call (Jev, local model, Claude escalation). */
  role: string | null;
  provider: 'claude' | 'openrouter' | 'local' | null;
  model: string | null;
  at: string;
  costUsd: number | null;
  tokens: CostTokens;
}

export interface CostMoney {
  costUsd: number;
  /** Input plus output tokens, the same measure the run tables show. */
  tokens: number;
  steps: number;
  /** Calls whose cost was not reported; they count in `steps` and add nothing to `costUsd`. */
  semCusto: number;
}

export interface CostShare {
  key: string;
  costUsd: number;
  tokens: number;
  steps: number;
  share: number;
}
