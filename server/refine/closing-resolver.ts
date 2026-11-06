import { ConflictError, type RefineSession } from './session.js';
import type { DocFile } from './draft.js';
import { leanRefine } from './limits.js';
import { safePatches, type PatchRow } from './state.js';
import { inTeamAlone } from './team-rule.js';

/** Rounds at most: each one accepts the safe patches, evaluates, decides the architecture and prepares the plans that are still open. */
export const CLOSING_ROUNDS = 3;

export { safePatches };

/** Resolves the closing checks with the agents, without the owner. It stops when the summary passes, when a round changes nothing, when the owner must act, or after CLOSING_ROUNDS. */
export async function resolveClosing(s: RefineSession, allowed: (p: PatchRow) => boolean = () => true): Promise<void> {
  // One resolver per session: a second call while one runs does nothing.
  if (resolving.has(s)) return;
  resolving.add(s);
  try {
    await resolveOnce(s, allowed);
  } finally {
    resolving.delete(s);
  }
}

const resolving = new WeakSet<RefineSession>();

async function resolveOnce(s: RefineSession, allowed: (p: PatchRow) => boolean): Promise<void> {
  // Before the review closes, only the stage documents are resolved: the later steps wait for the owner's Continuar.
  // A follow-on request has no review step: its closing runs at once, since the team alone prepares it.
  if (s.state.reviewClosed !== true && s.state.extension === undefined) return ignoreConflict(() => resolveStages(s));
  for (let round = 0; round < CLOSING_ROUNDS; round++) {
    const before = await s.closingSummary();
    if (before.ok) return;
    try {
      await resolveRound(s, before.checks.filter((c) => !c.ok).map((c) => c.id), allowed);
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
async function resolveRound(s: RefineSession, failing: string[], allowed: (p: PatchRow) => boolean): Promise<void> {
  const accepted = await resolveStages(s, allowed);
  // A round re-evaluates when a patch was accepted, a question is open, or the request's impact is missing or stale: the heal runs the impact step again.
  // Lean: the team alone evaluates again only when the impact was never measured; the fixes it applied are not checked by another full cycle.
  const lean = leanRefine() && inTeamAlone();
  const again = lean ? failing.includes('impact') && s.state.impact?.impact == null : accepted > 0 || failing.includes('questions') || failing.includes('impact');
  if (again) await s.evaluate();
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

/** A conflict is the owner's next move, so the resolver stops quietly. */
async function ignoreConflict(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
  }
}

/** Reviews each outdated stage again with its own role, then accepts the safe patches the rule allows; returns how many were accepted. */
export async function resolveStages(s: RefineSession, allowed: (p: PatchRow) => boolean = () => true, auto = false): Promise<number> {
  for (const file of Object.keys(s.state.staleBy ?? {}) as DocFile[]) {
    await s.evaluateStage(file);
    await s.settled();
  }
  // A finished document that left the graph goes back in, so the closing check on the graph passes without the owner.
  if (s.state.repositories === true) {
    for (const file of (s.state.doneStages ?? []).filter((f) => !(s.state.graphed ?? []).includes(f))) {
      await s.addToGraph(file);
      await s.settled();
    }
  }
  let accepted = 0;
  for (const p of safePatches(s.state.patches).filter(allowed)) {
    try {
      await s.accept(p.patchId, auto);
      accepted++;
    } catch (err) {
      // A patch the last one covered is dropped by the session; the others still apply.
      if (!(err instanceof ConflictError)) throw err;
    }
  }
  return accepted;
}
