import type { Accounting } from '../budget/accounting.js';
import { resolveDecision, type Config } from '../config/config.js';
import { ClaudeEscalateBackend, type EscalationRunner } from './claude-escalate.js';
import { Decider } from './decider.js';
import { JevOpenRouterBackend } from './jev-openrouter.js';
import { LocalLogprobsBackend } from './local-logprobs.js';
import { LocalStubBackend } from './local-stub.js';
import type { BackendName, DecisionBackend, DecisionRecord } from './types.js';

export interface CreateDeciderDeps {
  cfg: Config;
  /** From loadSecrets(cfg.paths.secrets); only OPENROUTER_API_KEY is read here, every value is redacted from states. */
  secrets: Record<string, string>;
  accounting: Accounting;
  runEscalation: EscalationRunner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onDecision?: (record: DecisionRecord) => void;
  clock?: () => Date;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spec 10A.0 chain: jev (when a key exists) → local (when enabled, else the stub) → claude. Cost lands in accounting under system1. */
export function createDecider(deps: CreateDeciderDeps): Decider {
  const l = deps.cfg.decisions.local;
  const backends: Partial<Record<BackendName, DecisionBackend>> = {
    local: l.enabled ? new LocalLogprobsBackend({ fetch: deps.fetch ?? globalThis.fetch, baseUrl: l.baseUrl, timeoutMs: l.timeoutMs, nProbs: l.nProbs }) : new LocalStubBackend(),
    claude: new ClaudeEscalateBackend(deps.runEscalation),
  };
  const key = deps.secrets.OPENROUTER_API_KEY;
  if (typeof key === 'string' && key.trim() !== '') {
    const o = deps.cfg.decisions.openrouter;
    backends.jev = new JevOpenRouterBackend({
      fetch: deps.fetch ?? globalThis.fetch,
      apiKey: key,
      baseUrl: o.baseUrl,
      model: o.model,
      timeoutMs: o.timeoutMs,
      maxTries: o.maxTries,
      backoffMs: o.backoffMs,
      sleep: deps.sleep ?? defaultSleep,
    });
  }
  return new Decider({
    backends,
    config: (id) => resolveDecision(deps.cfg, id),
    knownSecrets: () => Object.values(deps.secrets),
    clock: deps.clock,
    onDecision: (record) => {
      // Spec 10A.2: Jev cost is booked here, per attempt, even when Claude gave the final answer.
      // A Claude escalation is a runStep, which already books its own usage; booking it again would double it.
      for (const attempt of record.attempts) {
        if (attempt.backend === 'claude' || !attempt.usage) continue;
        deps.accounting.record({
          role: 'system1',
          phase: 'decide',
          taskId: null,
          attempt: 0,
          stepKind: 'decide',
          provider: attempt.backend === 'jev' ? 'openrouter' : 'local',
          model: attempt.model ?? 'unknown',
          usage: { inputTokens: attempt.usage.inputTokens, outputTokens: attempt.usage.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: attempt.usage.costUsd,
          durationMs: record.durationMs,
          numTurns: 0,
          at: record.at,
        });
      }
      deps.onDecision?.(record);
    },
  });
}
