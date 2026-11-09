import { ConflictError, type RefineSession } from './session.js';
import { resolveClosing, resolveStages } from './closing-resolver.js';
import { DOC_STAGES } from './doc-stages.js';
import { type PatchRow } from './state.js';
import { leanRefine } from './limits.js';
import { SPECS_REVIEWERS } from './specs-review.js';
import { asTeamAlone, autoAcceptable } from './team-rule.js';

/**
 * The follow-on request the team runs on its own: evaluated, then resolved to ready without the owner's button.
 * The start and the stop are journaled, so the screen asks the owner only for what the team stopped on.
 */
export async function runExtension(s: RefineSession, { evaluate = true }: { evaluate?: boolean } = {}): Promise<void> {
  await s.teamAutopilot('started');
  let failure: string | null = null;
  try {
    await asTeamAlone(true, async () => {
      // After the owner decided the suggestions the documents are already evaluated: the team checks and prepares what changed.
      if (evaluate) await s.evaluate();
      await resolveEverything(s, { byOwner: false });
    });
  } catch (err) {
    failure = `O time parou com um erro: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    await s.teamAutopilot('stopped', [...(failure ? [failure] : []), ...leftForOwner(s)]);
  }
}

/** The owner's "accept all": every suggestion that waits is accepted, one another change already covered is skipped; returns how many were accepted. */
export async function acceptAllPending(s: Pick<RefineSession, 'state' | 'accept'>): Promise<number> {
  let accepted = 0;
  for (const p of s.state.patches.filter((x) => x.status === 'pending')) {
    try {
      await s.accept(p.patchId);
      accepted += 1;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
  }
  return accepted;
}

const countOf = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What the team could not settle, in plain words for the owner; empty when everything is settled. */
export function leftForOwner(s: Pick<RefineSession, 'state'>): string[] {
  const st = s.state;
  const reasons: string[] = [];
  const questions = st.questions.filter((q) => q.status === 'pending').length;
  if (questions > 0) reasons.push(`O time não conseguiu decidir ${countOf(questions, 'pergunta', 'perguntas')}.`);
  const patches = st.patches.filter((p) => p.status === 'pending').length;
  if (patches > 0) reasons.push(`${countOf(patches, 'sugestão muda', 'sugestões mudam')} o escopo e ${patches === 1 ? 'espera' : 'esperam'} a sua decisão.`);
  if (st.speckit?.status === 'failed') reasons.push('A preparação dos planos falhou.');
  // A cycle that failed (the Claude login expired, a quota) says why, so the owner is not left with a silent stop.
  if (st.error) reasons.push(st.error);
  const rejectedBy = SPECS_REVIEWERS.filter((role) => st.specsReview?.[role]?.specsHash === st.specsMd?.hash && st.specsReview?.[role]?.verdict === 'rejected');
  if (rejectedBy.length > 0) reasons.push(`${rejectedBy.map((role) => role.toUpperCase()).join(' e ')} apontaram problemas no specs.md; veja em "Verificação". O desenvolvimento não fica bloqueado.`);
  return reasons;
}

/** The rounds the team works through before it follows the specs.md on the owner's word. */
const ROUNDS = 5;

const resolving = new WeakSet<RefineSession>();
/** The sessions whose owner pressed Parar: the team ends its rounds at the next step instead of starting another. */
const halted = new WeakSet<RefineSession>();

/** Parar stops the whole team, not only the step running now. */
export function haltTeam(s: RefineSession): void {
  if (resolving.has(s)) halted.add(s);
}

/** A question whose rule the team already answered once: it came back, so the owner decides it instead of another round. */
const repeated = (s: Pick<RefineSession, 'state'>, q: { questionId: string; rule?: string }): boolean =>
  q.rule !== undefined && s.state.questions.some((o) => o.questionId !== q.questionId && o.rule === q.rule && o.status === 'answered');

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
  halted.delete(s);
  const teamAlone = !byOwner && s.state.extension !== undefined;
  try {
    await asTeamAlone(teamAlone, () => runRounds(s, teamAlone));
  } finally {
    resolving.delete(s);
    halted.delete(s);
  }
}

/** Whether a question or a suggestion still waits for a decision. */
const leftOpen = (s: Pick<RefineSession, 'state'>): boolean => s.state.questions.some((q) => q.status === 'pending') || s.state.patches.some((p) => p.status === 'pending');

async function runRounds(s: RefineSession, teamAlone: boolean): Promise<void> {
  const allowed = (p: PatchRow) => autoAcceptable(p, teamAlone);
  const lean = teamAlone && leanRefine();
  const go = () => !halted.has(s);
  for (let round = 0; round < ROUNDS && go() && !(await startIsClear(s)); round++) {
    // A rule that comes back after the team answered it would only loop: the owner decides it.
    if (s.state.questions.some((q) => q.status === 'pending' && repeated(s, q))) return;
    // The documents: stages outdated by an edit are reviewed again, and every suggestion is accepted.
    await tolerate(() => resolveStages(s, allowed, teamAlone, go));
    if (!go()) return;
    const tried = new Set<string>();
    for (const p of s.state.patches.filter((x) => x.status === 'pending' && allowed(x))) {
      tried.add(p.patchId);
      await tolerate(() => s.accept(p.patchId, teamAlone));
    }
    // The questions: each one is answered by the team (the recommended choice, or the PO's decision written into the documents).
    for (const q of s.state.questions.filter((x) => x.status === 'pending')) if (go()) await tolerate(() => s.decideAnswer(q.questionId));
    // Lean: the team evaluated once; with nothing left for the owner, what the reviewers found is applied, so their failed checks stand settled.
    if (lean && !leftOpen(s)) await tolerate(() => s.settleChecklist());
    // The backlog, then specs.md with the PO deciding what it would have asked, then the plans.
    const backlog = s.state.backlog;
    if (!go()) return;
    if (!lean && backlog?.enabled && s.state.status !== 'ready') await tolerate(() => s.evaluate());
    if (!go()) return;
    await tolerate(() => s.startSpecs({ autonomous: true }));
    await tolerate(() => s.settled());
    // Lean: the reviewers check the specs.md that was followed while the plans are written, so they add no minutes.
    const beside = lean ? tolerate(() => s.reviewSpecsBeside()) : undefined;
    if (!go()) return;
    // A new suggestion the team takes next round changes the documents and would throw the plans away: the plans wait for it.
    const fresh = s.state.patches.some((p) => p.status === 'pending' && allowed(p) && !tried.has(p.patchId));
    if (!fresh && (s.state.speckit?.status !== 'done' || s.state.speckit.stale)) {
      await tolerate(() => s.runPlans());
      await tolerate(() => s.settled());
    }
    await beside;
  }
  if (!go()) return;
  // A suggestion proposed after the last accept pass of a round is taken here, so none the team may accept is left behind.
  for (const p of s.state.patches.filter((x) => x.status === 'pending' && allowed(x))) await tolerate(() => s.accept(p.patchId, teamAlone));
  // What a reviewer still rejects after the rounds is followed, since the owner delegated the decision to the team.
  if (!s.specsApproved() && s.state.specsMd !== undefined && s.state.specsMd !== null) await tolerate(() => s.approveSpecsAnyway());
  // Last: the closing checks the request still fails (the architecture, the impact) are decided by the team, then every document goes into the graph in one extraction.
  if (s.state.extension !== undefined) {
    await tolerate(() => resolveClosing(s, allowed));
    await tolerate(() => s.graphDocs());
  } else {
    for (const file of DOC_STAGES.filter((f) => !(s.state.graphed ?? []).includes(f))) {
      await tolerate(() => s.addToGraph(file));
      await tolerate(() => s.settled());
    }
  }
  if (!teamAlone) await tolerate(() => s.saveDocs());
}
