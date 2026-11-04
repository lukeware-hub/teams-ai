import { ConflictError, type RefineSession } from './session.js';
import { resolveStages } from './closing-resolver.js';
import { DOC_STAGES } from './doc-stages.js';
import { type PatchRow, isApproval } from './state.js';
import { additiveOnly } from './scope-guard.js';

/** The documents a request may change without the owner, and only by adding to them: stack and design stay with the owner. */
const REQUEST_FILES: readonly string[] = ['project.md', 'flow.md', 'briefing.md'];

/**
 * Whether a pending suggestion is accepted without the owner. The team alone, on a follow-on request, takes only additions to its
 * project's own documents, so a removal, a rewording, an adjustment's approval or a stack or design change waits for the owner.
 */
export function autoAcceptable(p: Pick<PatchRow, 'file' | 'find' | 'replace'>, teamAlone: boolean): boolean {
  if (!teamAlone) return true;
  return REQUEST_FILES.includes(p.file) && additiveOnly(p.find, p.replace) && !isApproval(p);
}

/** The rounds the team works through before it follows the specs.md on the owner's word. */
const ROUNDS = 5;

const resolving = new WeakSet<RefineSession>();

/** Whether nothing keeps "Iniciar desenvolvimento" closed: the backlog ready, no open question, specs.md approved, the plans prepared. */
export async function startIsClear(s: RefineSession): Promise<boolean> {
  const st = s.state;
  const plans = st.speckit?.status === 'done' && !st.speckit.stale;
  return st.status === 'ready' && !st.questions.some((q) => q.status === 'pending' && q.blocking) && s.specsApproved() && plans;
}

/** A step that the session may refuse because of the moment it is in: the autopilot goes on to the next one. */
const tolerate = async (run: () => Promise<unknown> | null | undefined): Promise<void> => {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
  }
};

/**
 * The owner's button for everything: with full autonomy the team answers every open question itself, accepts every suggestion,
 * reviews what changed, repairs and settles specs.md and prepares the plans, until nothing keeps the start closed.
 * After the last round a specs.md a reviewer still rejects is followed on the owner's behalf, since the owner chose this path.
 * A follow-on request the team runs alone (not by the owner's button) keeps that decision, and the save in the repositories, for the owner.
 */
export async function resolveEverything(s: RefineSession, { byOwner = true }: { byOwner?: boolean } = {}): Promise<void> {
  if (resolving.has(s)) return;
  resolving.add(s);
  const teamAlone = !byOwner && s.state.extension !== undefined;
  const allowed = (p: PatchRow) => autoAcceptable(p, teamAlone);
  try {
    for (let round = 0; round < ROUNDS && !(await startIsClear(s)); round++) {
      // The documents: stages outdated by an edit are reviewed again, and the suggestions the rule allows are accepted.
      await tolerate(() => resolveStages(s, allowed));
      for (const p of s.state.patches.filter((x) => x.status === 'pending' && allowed(x))) await tolerate(() => s.accept(p.patchId));
      // The questions: each one is answered by the team (the recommended choice, or the PO's decision written into the documents).
      for (const q of s.state.questions.filter((x) => x.status === 'pending')) await tolerate(() => s.decideAnswer(q.questionId));
      // The backlog, then specs.md with the PO deciding what it would have asked, then the plans.
      const backlog = s.state.backlog;
      if (backlog?.enabled && s.state.status !== 'ready') await tolerate(() => s.evaluate());
      await tolerate(() => s.startSpecs({ autonomous: true }));
      await tolerate(() => s.settled());
      if (s.state.speckit?.status !== 'done' || s.state.speckit.stale) {
        await tolerate(() => s.runPlans());
        await tolerate(() => s.settled());
      }
    }
    // What a reviewer still rejects after the rounds is followed, since the owner delegated the decision with his button.
    if (byOwner && !s.specsApproved() && s.state.specsMd !== undefined && s.state.specsMd !== null) await tolerate(() => s.approveSpecsAnyway());
    // Last: every document goes into the graph, and the owner's run saves the documents and specs in the repositories.
    for (const file of DOC_STAGES.filter((f) => !(s.state.graphed ?? []).includes(f))) {
      await tolerate(() => s.addToGraph(file));
      await tolerate(() => s.settled());
    }
    if (byOwner) await tolerate(() => s.saveDocs());
  } finally {
    resolving.delete(s);
  }
}
