import { CHAT_MODEL } from '../chat/service.js';
import type { ChatMessage, ChatUsage } from '../chat/store.js';
import type { StoredEvent } from '../store/event-store.js';
import type { CostFact, CostStage, CostTokens } from './cost-types.js';

/** The journal a fact comes from: its stage, project, spec and run. */
export interface JournalContext {
  stage: CostStage;
  projectId: string | null;
  specId: string | null;
  runId: string | null;
}

interface StartedStep {
  role: string | null;
  kind: string;
  model: string | null;
  taskId: string | null;
  phase: string;
}

interface Usage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  costUsd?: unknown;
}

const DECISION_BACKENDS = new Map<string, { kind: string; provider: NonNullable<CostFact['provider']> }>([
  ['jev', { kind: 'decisao-jev', provider: 'openrouter' }],
  ['local', { kind: 'decisao-local', provider: 'local' }],
  ['claude', { kind: 'decisao-claude', provider: 'claude' }],
]);

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function tokensOf(usage: Usage | null | undefined): CostTokens {
  return {
    inputTokens: num(usage?.inputTokens) ?? 0,
    outputTokens: num(usage?.outputTokens) ?? 0,
    cacheReadTokens: num(usage?.cacheReadTokens) ?? 0,
    cacheWriteTokens: num(usage?.cacheWriteTokens) ?? 0,
  };
}

/** The repository each task of a plan runs in, from the plan's own task events. */
function servicesOf(events: readonly StoredEvent[]): Map<string, string> {
  const services = new Map<string, string>();
  for (const e of events) {
    const task = e.type === 'TASK_PLANNED' ? (e.data.task as { id?: unknown; service?: unknown } | undefined) : undefined;
    if (text(task?.id) !== null && text(task?.service) !== null) services.set(String(task!.id), String(task!.service));
  }
  return services;
}

/**
 * Every charge a journal holds, one fact each: a finished agent step, a Jev score, and each decision model call that made a call.
 * A step with no reported cost is kept with a null cost, so the count of steps stays true.
 */
/** One fact per chat answer that made a call; the chat keeps no journal, so its file is the record. */
export function factsOfChat(projectId: string, messages: ReadonlyArray<ChatMessage>): CostFact[] {
  return messages
    .filter((m): m is ChatMessage & { usage: ChatUsage } => m.role === 'assistant' && m.usage !== undefined)
    .map((m) => ({
      stage: 'chat',
      projectId,
      specId: null,
      runId: null,
      repository: null,
      taskId: null,
      attempt: 0,
      phase: 'chat',
      kind: 'resposta',
      role: 'po',
      provider: 'claude',
      model: CHAT_MODEL,
      at: m.at,
      costUsd: num(m.usage.costUsd),
      tokens: tokensOf(m.usage),
    }));
}

export function factsOfJournal(events: readonly StoredEvent[], ctx: JournalContext): CostFact[] {
  const services = servicesOf(events);
  const started = new Map<string, StartedStep>();
  const out: CostFact[] = [];
  const base = { stage: ctx.stage, projectId: ctx.projectId, specId: ctx.specId, runId: ctx.runId };
  for (const e of events) {
    const d = e.data;
    if (e.type === 'STEP_STARTED') {
      started.set(String(d.stepId), { role: text(d.role), kind: text(d.kind) ?? 'desconhecido', model: text(d.model), taskId: text(d.taskId), phase: text(d.phase) ?? 'desconhecida' });
    } else if (e.type === 'STEP_FINISHED') {
      const s = started.get(String(d.stepId));
      const taskId = text(d.taskId) ?? s?.taskId ?? null;
      out.push({
        ...base,
        at: e.at,
        repository: taskId === null ? null : (services.get(taskId) ?? null),
        taskId,
        attempt: num(d.attempt) ?? 0,
        phase: s?.phase ?? 'desconhecida',
        kind: text(d.kind) ?? s?.kind ?? 'desconhecido',
        role: s?.role ?? null,
        provider: 'claude',
        model: text(d.model) ?? s?.model ?? null,
        costUsd: num(d.costUsd),
        tokens: tokensOf(d.usage as Usage | undefined),
      });
    } else if (e.type === 'DECISION_MADE') {
      const attempts = (d.record as { attempts?: Array<{ backend?: unknown; model?: unknown; usage?: Usage | null }> } | undefined)?.attempts ?? [];
      for (const a of attempts) {
        const backend = DECISION_BACKENDS.get(String(a.backend));
        if (!backend || !a.usage) continue;
        out.push({ ...base, at: e.at, repository: null, taskId: null, attempt: 0, phase: 'decisao', kind: backend.kind, role: null, provider: backend.provider, model: text(a.model), costUsd: num(a.usage.costUsd), tokens: tokensOf(a.usage) });
      }
    } else if (e.type === 'REFINE_DOCS_SCORED' && ctx.stage === 'refinement' && d.usage) {
      const usage = d.usage as Usage;
      out.push({ ...base, at: e.at, repository: null, taskId: null, attempt: 0, phase: 'refine', kind: 'avaliacao-jev', role: null, provider: 'openrouter', model: text(d.model), costUsd: num(usage.costUsd), tokens: tokensOf(usage) });
    }
  }
  return out;
}
