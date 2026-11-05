import type { StepKind } from '../agents/outputs.js';
import type { Accounting } from '../budget/accounting.js';
import type { Role } from '../config/config.js';
import type { StoredEvent } from '../store/event-store.js';
import { OrchEvent } from './events.js';

type Tokens = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

const DECISION_PROVIDER: Record<string, 'openrouter' | 'local' | 'claude'> = { jev: 'openrouter', local: 'local', claude: 'claude' };

/**
 * Budgets span the whole run, not one process: a process that starts again on a run rebuilds the accounting from the journal.
 * It replays the finished steps, and every decision call that was billed, the same way the live run books them.
 */
export function replayAccounting(events: readonly StoredEvent[], accounting: Accounting): void {
  const started = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    if (e.type === OrchEvent.StepStarted) started.set(String(e.data.stepId), e.data);
    if (e.type === OrchEvent.StepFinished) replayStep(e, started.get(String(e.data.stepId)), accounting);
    if (e.type === OrchEvent.DecisionMade) replayDecision(e, accounting);
  }
}

function replayStep(e: StoredEvent, s: Record<string, unknown> | undefined, accounting: Accounting): void {
  const usage = e.data.usage as Tokens | undefined;
  if (!s || !usage) return;
  accounting.record({
    role: s.role as Role,
    phase: e.data.taskId ? 'phase3' : 'phase',
    taskId: (e.data.taskId as string | null) ?? null,
    attempt: Number(e.data.attempt ?? 0),
    stepKind: e.data.kind as StepKind,
    provider: 'claude',
    model: 'unknown',
    usage,
    costUsd: (e.data.costUsd as number | null) ?? null,
    durationMs: Number(e.data.durationMs ?? 0),
    numTurns: Number(e.data.numTurns ?? 0),
    at: e.at,
  });
}

/** A decision attempt that made a billed call. The live run books Jev and local calls itself; a Claude escalation books itself as a step, so the replay books each one once here. */
function replayDecision(e: StoredEvent, accounting: Accounting): void {
  const attempts = (e.data.record as { attempts?: Array<{ backend?: unknown; model?: unknown; usage?: { inputTokens: number; outputTokens: number; costUsd: number | null } | null }> } | undefined)?.attempts ?? [];
  for (const a of attempts) {
    const provider = DECISION_PROVIDER[String(a.backend)];
    if (!provider || !a.usage) continue;
    accounting.record({
      role: 'system1',
      phase: 'decide',
      taskId: null,
      attempt: 0,
      stepKind: 'decide',
      provider,
      model: typeof a.model === 'string' ? a.model : 'unknown',
      usage: { inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: a.usage.costUsd,
      durationMs: 0,
      numTurns: 0,
      at: e.at,
    });
  }
}
