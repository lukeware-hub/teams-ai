import { redactSecrets } from '../core/redact.js';
import {
  minConfidence,
  type AttemptOutcome,
  type BackendName,
  type BackendResult,
  type BackendUsage,
  type DecisionAttempt,
  type DecisionBackend,
  type DecisionConfig,
  type DecisionId,
  type DecisionOutcome,
  type DecisionRecord,
  type Questions,
} from './types.js';

/** Well under Jev's 32k-token context even for dense text (spec 10A.2 state size cap). */
export const MAX_STATE_CHARS = 24_000;
export const TRUNCATION_MARK = '\n[... state truncated by decide ...]';

export function capState(state: string): { state: string; truncated: boolean } {
  if (state.length <= MAX_STATE_CHARS) return { state, truncated: false };
  return { state: state.slice(0, MAX_STATE_CHARS) + TRUNCATION_MARK, truncated: true };
}

export interface DeciderDeps {
  backends: Partial<Record<BackendName, DecisionBackend>>;
  config: (id: DecisionId) => DecisionConfig;
  /** Secret values to strip from every state before it leaves the orchestrator (spec §14). */
  knownSecrets?: () => readonly string[];
  onDecision?: (record: DecisionRecord) => void;
  clock?: () => Date;
}

export interface DecideContext {
  confidential: boolean;
  /** Gets the full record of this call, the one `onDecision` gets too; a caller that journals decisions keeps it. */
  onRecord?: (record: DecisionRecord) => void;
}

const ZERO_USAGE: BackendUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };

function addUsage(a: BackendUsage, b: BackendUsage): BackendUsage {
  const cost = a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: cost === null ? null : Math.round(cost * 1e8) / 1e8,
  };
}

/**
 * Spec 10A.0: rules first (in the caller), then the configured chain, then the caller's default.
 * The decider never knows HTTP or processes; backends are injected.
 */
export class Decider {
  private readonly clock: () => Date;

  constructor(private readonly deps: DeciderDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async decide(id: DecisionId, rawState: string, questions: Questions, ctx: DecideContext): Promise<DecisionOutcome> {
    const started = this.clock();
    const cfg = this.deps.config(id);
    const known = this.deps.knownSecrets?.() ?? [];
    const redacted = redactSecrets(rawState, known);
    const { state, truncated } = capState(redacted);
    const attempts: DecisionAttempt[] = [];
    let usage = ZERO_USAGE;
    const skipped = (backend: BackendName, outcome: AttemptOutcome): DecisionAttempt => ({ backend, outcome, confidence: null, model: null, usage: null, message: null });

    const emit = (outcome: DecisionOutcome, backend: BackendName | null, model: string | null) => {
      const record: DecisionRecord = {
        decisionId: id,
        backend,
        model,
        escalated: outcome.answered ? outcome.escalated : false,
        answers: outcome.answered ? outcome.answers : null,
        attempts,
        usage,
        stateChars: rawState.length,
        stateTruncated: truncated,
        durationMs: this.clock().getTime() - started.getTime(),
        at: started.toISOString(),
      };
      this.deps.onDecision?.(record);
      ctx.onRecord?.(record);
      return outcome;
    };

    if (!cfg.enabled || cfg.chain.length === 0) return emit({ answered: false, reason: 'disabled' }, null, null);

    for (const name of cfg.chain) {
      if (name === 'jev' && ctx.confidential) {
        attempts.push(skipped(name, 'skipped-confidential'));
        continue;
      }
      const backend = this.deps.backends[name];
      if (!backend) {
        attempts.push(skipped(name, 'missing-backend'));
        continue;
      }
      let result: BackendResult;
      try {
        result = await backend.evaluate({ state, questions, escalateTo: cfg.escalateTo });
      } catch (err) {
        result = { ok: false, reason: 'unavailable', message: (err as Error).message };
      }
      if (!result.ok) {
        attempts.push({ ...skipped(name, result.reason), message: redactSecrets(result.message, known) });
        continue;
      }
      usage = addUsage(usage, result.usage);
      const answered = (outcome: AttemptOutcome, confidence: number | null): DecisionAttempt => ({
        backend: name,
        outcome,
        confidence,
        model: result.model,
        usage: result.usage,
        message: null,
      });
      if (name === 'claude') {
        attempts.push(answered('answered', null));
        return emit({ answered: true, answers: result.answers, backend: name, escalated: true }, name, result.model);
      }
      const confidence = minConfidence(result.answers);
      if (confidence >= cfg.thresholds[name]) {
        attempts.push(answered('answered', confidence));
        return emit({ answered: true, answers: result.answers, backend: name, escalated: false }, name, result.model);
      }
      attempts.push({ ...answered('low-confidence', confidence), answers: result.answers });
    }
    return emit({ answered: false, reason: 'exhausted' }, null, null);
  }
}
