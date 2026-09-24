import { redactSecrets } from '../core/redact.js';
import {
  minConfidence,
  type AttemptOutcome,
  type BackendName,
  type BackendResult,
  type BackendUsage,
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
    const redacted = redactSecrets(rawState, this.deps.knownSecrets?.() ?? []);
    const { state, truncated } = capState(redacted);
    const attempts: DecisionRecord['attempts'] = [];
    let usage = ZERO_USAGE;

    const emit = (outcome: DecisionOutcome, backend: BackendName | null, model: string | null) => {
      this.deps.onDecision?.({
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
      });
      return outcome;
    };

    if (!cfg.enabled || cfg.chain.length === 0) return emit({ answered: false, reason: 'disabled' }, null, null);

    for (const name of cfg.chain) {
      if (name === 'jev' && ctx.confidential) {
        attempts.push({ backend: name, outcome: 'skipped-confidential', confidence: null });
        continue;
      }
      const backend = this.deps.backends[name];
      if (!backend) {
        attempts.push({ backend: name, outcome: 'missing-backend', confidence: null });
        continue;
      }
      let result: BackendResult;
      try {
        result = await backend.evaluate({ state, questions, escalateTo: cfg.escalateTo });
      } catch (err) {
        result = { ok: false, reason: 'unavailable', message: (err as Error).message };
      }
      if (!result.ok) {
        attempts.push({ backend: name, outcome: result.reason as AttemptOutcome, confidence: null });
        continue;
      }
      usage = addUsage(usage, result.usage);
      if (name === 'claude') {
        attempts.push({ backend: name, outcome: 'answered', confidence: null });
        return emit({ answered: true, answers: result.answers, backend: name, escalated: true }, name, result.model);
      }
      const confidence = minConfidence(result.answers);
      if (confidence >= cfg.thresholds[name]) {
        attempts.push({ backend: name, outcome: 'answered', confidence });
        return emit({ answered: true, answers: result.answers, backend: name, escalated: false }, name, result.model);
      }
      attempts.push({ backend: name, outcome: 'low-confidence', confidence });
    }
    return emit({ answered: false, reason: 'exhausted' }, null, null);
  }
}
