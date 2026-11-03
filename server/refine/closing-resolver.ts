import { ConflictError, type RefineSession } from './session.js';
import { isApproval, type PatchRow } from './state.js';

/** Rounds at most: each one accepts the safe patches, evaluates, decides the architecture and prepares the plans that are still open. */
export const CLOSING_ROUNDS = 3;

/** The patches the agents may accept alone: no scope change and no owner decision. */
export const safePatches = (rows: readonly PatchRow[]): PatchRow[] => rows.filter((p) => p.status === 'pending' && !p.scopeChange && !isApproval(p));

/** Resolves the closing checks with the agents, without the owner. It stops when the summary passes, when a round changes nothing, when the owner must act, or after CLOSING_ROUNDS. */
export async function resolveClosing(s: RefineSession): Promise<void> {
  for (let round = 0; round < CLOSING_ROUNDS; round++) {
    const before = await s.closingSummary();
    if (before.ok) return;
    try {
      await resolveRound(s, before.checks.filter((c) => !c.ok).map((c) => c.id));
    } catch (err) {
      // A busy draft or a refused step is the owner's next move, so the resolver waits instead of forcing it.
      if (err instanceof ConflictError) return;
      throw err;
    }
    const after = await s.closingSummary();
    if (after.ok || after.summaryHash === before.summaryHash) return;
  }
}

/** One round, in the order the checks depend on: patches, then the checklist, then the architecture, then the plans. */
async function resolveRound(s: RefineSession, failing: string[]): Promise<void> {
  let accepted = 0;
  for (const p of safePatches(s.state.patches)) {
    try {
      await s.accept(p.patchId);
      accepted++;
    } catch (err) {
      // A patch the last one covered is dropped by the session; the others still apply.
      if (!(err instanceof ConflictError)) throw err;
    }
  }
  if (accepted > 0 || failing.includes('questions')) await s.evaluate();
  if (s.state.architecture == null || (await s.isArchitectureStale())) {
    await s.decideArchitecture();
    await s.settled();
  }
  const current = (await s.closingSummary()).checks.filter((c) => !c.ok).map((c) => c.id);
  if (['specs', 'plans', 'tasks'].some((id) => current.includes(id))) {
    await s.runPlans();
    await s.settled();
  }
}
