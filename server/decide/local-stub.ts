import type { BackendInput, BackendResult, DecisionBackend } from './types.js';

/**
 * Spec 10A.2a: phase 1 ships the slot in the chain, not the model. Reporting "unavailable" makes
 * the decider fall through to claude-escalate exactly as it will when the real llama.cpp server is down.
 */
export class LocalStubBackend implements DecisionBackend {
  readonly name = 'local' as const;

  async evaluate(_input: BackendInput): Promise<BackendResult> {
    return { ok: false, reason: 'unavailable', message: 'local-logprobs backend is not built yet (spec 10A.2a, phase 2)' };
  }
}
