import { ConflictError, type RefineSession } from './session.js';
import { resolveStages } from './closing-resolver.js';
import { DOC_STAGES } from './doc-stages.js';

/** The follow-on request the team runs on its own: evaluated, then resolved to ready without the owner's button. */
export const runExtension = (s: RefineSession): Promise<void> => s.evaluate().then(() => resolveEverything(s, { byOwner: false }));

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
 * A follow-on request the team runs alone decides everything too, and leaves only the save in the repositories and "Iniciar" to the owner.
 */
export async function resolveEverything(s: RefineSession, { byOwner = true }: { byOwner?: boolean } = {}): Promise<void> {
  if (resolving.has(s)) return;
  resolving.add(s);
  const teamAlone = !byOwner && s.state.extension !== undefined;
  try {
    for (let round = 0; round < ROUNDS && !(await startIsClear(s)); round++) {
      // The documents: stages outdated by an edit are reviewed again, and every suggestion is accepted.
      await tolerate(() => resolveStages(s, () => true, teamAlone));
      for (const p of s.state.patches.filter((x) => x.status === 'pending')) await tolerate(() => s.accept(p.patchId, teamAlone));
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
    // What a reviewer still rejects after the rounds is followed, since the owner delegated the decision to the team.
    if (!s.specsApproved() && s.state.specsMd !== undefined && s.state.specsMd !== null) await tolerate(() => s.approveSpecsAnyway());
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
