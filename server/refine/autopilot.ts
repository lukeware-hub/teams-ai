import { ConflictError, type RefineSession } from './session.js';
import { resolveClosing, resolveStages } from './closing-resolver.js';
import { DOC_STAGES } from './doc-stages.js';
import { type PatchRow } from './state.js';
import type { DocFile } from './draft.js';
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

/** The team works on what the owner decided: a follow-on request runs alone, a first draft goes through the owner's button for everything. */
export const runTeam = (s: RefineSession, { evaluate = true }: { evaluate?: boolean } = {}): Promise<void> =>
  s.state.extension === undefined ? resolveEverything(s) : runExtension(s, { evaluate });

/** With yes to "agents decide" in Settings, the team goes on alone with what still keeps the start closed; with no, it waits for the owner. */
export async function decideWhenDelegated(s: RefineSession): Promise<void> {
  if (stopped.has(s)) return;
  const waiting = leftOpen(s) || (s.state.backlog?.detail === true && !(await startIsClear(s)));
  if (waiting && (await s.agentsDecide())) await runTeam(s, { evaluate: false });
}

/** The owner's "accept all", in one stage or in all: every suggestion that waits is accepted, or queued while the team works; one another change already covered is skipped. */
export async function acceptAllPending(s: Pick<RefineSession, 'state' | 'decide'>, file?: DocFile): Promise<{ accepted: number; queued: number }> {
  const counts = { accepted: 0, queued: 0 };
  for (const p of s.state.patches.filter((x) => x.status === 'pending' && (file === undefined || x.file === file) && !s.state.queued?.some((q) => q.id === x.patchId))) {
    try {
      counts[(await s.decide({ kind: 'accept', id: p.patchId })) ? 'queued' : 'accepted'] += 1;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
  }
  return counts;
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

const resolving = new WeakSet<RefineSession>();
/** The sessions whose owner pressed Parar: the team ends its rounds at the next step instead of starting another. */
const halted = new WeakSet<RefineSession>();

/** The sessions the owner stopped: "agents decide" does not start the team again until the owner starts work. */
const stopped = new WeakSet<RefineSession>();

/** Parar stops the whole team, not only the step running now, and keeps it stopped. */
export function haltTeam(s: RefineSession): void {
  stopped.add(s);
  if (resolving.has(s)) halted.add(s);
}

/** The owner started work again: "agents decide" may go on alone after it. */
export function ownerResumed(s: RefineSession): void {
  stopped.delete(s);
}

/** Whether nothing keeps "Iniciar desenvolvimento" closed: the backlog ready, no open question, specs.md written and checked, the plans prepared. */
export async function startIsClear(s: RefineSession): Promise<boolean> {
  const st = s.state;
  const plans = st.speckit?.status === 'done' && !st.speckit.stale;
  return st.status === 'ready' && !st.questions.some((q) => q.status === 'pending' && q.blocking) && s.specsReady() && plans;
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
 * The owner's button for everything, in one pass: the team takes the suggestions, answers the open questions itself, writes specs.md,
 * takes the reviewers' adjustments to it once and prepares the plans. No review runs twice: what is still open stays for the owner to read.
 * A follow-on request the team runs alone decides everything too, and leaves only the save in the repositories and "Iniciar" to the owner.
 */
export async function resolveEverything(s: RefineSession, { byOwner = true }: { byOwner?: boolean } = {}): Promise<void> {
  if (resolving.has(s)) return;
  resolving.add(s);
  halted.delete(s);
  const teamAlone = !byOwner && s.state.extension !== undefined;
  try {
    await asTeamAlone(teamAlone, () => runPass(s, teamAlone));
  } finally {
    resolving.delete(s);
    halted.delete(s);
  }
}

/** Whether a question or a suggestion still waits for a decision. */
const leftOpen = (s: Pick<RefineSession, 'state'>): boolean => s.state.questions.some((q) => q.status === 'pending') || s.state.patches.some((p) => p.status === 'pending');

async function runPass(s: RefineSession, teamAlone: boolean): Promise<void> {
  const allowed = (p: PatchRow) => autoAcceptable(p, teamAlone);
  const go = () => !halted.has(s);
  if ((await startIsClear(s)) && !leftOpen(s)) return;
  // What the reviews left open is decided once: the suggestions the team may take are taken, the questions answered, the rest set aside.
  const settleOpen = async () => {
    for (const p of s.state.patches.filter((x) => x.status === 'pending' && allowed(x))) if (go()) await tolerate(() => s.accept(p.patchId, teamAlone));
    if (!teamAlone) {
      if (go()) await tolerate(() => s.proceedWithout());
      return;
    }
    // A request the team runs alone leaves a scope change to the owner: only the questions are answered.
    for (const q of s.state.questions.filter((x) => x.status === 'pending')) if (go()) await tolerate(() => s.decideAnswer(q.questionId));
  };
  // The documents: stages outdated by an edit are reviewed once more, then what they found is settled.
  await tolerate(() => resolveStages(s, allowed, teamAlone, go));
  if (go()) await settleOpen();
  // The backlog, evaluated when the documents changed; what that review found is settled the same way. A request the team runs alone was evaluated before this pass.
  if (go() && !teamAlone && s.state.backlog?.enabled && s.state.status !== 'ready') {
    await tolerate(() => s.evaluate());
    if (go()) await settleOpen();
  }
  // specs.md is written and reviewed once; the reviewers' adjustments are taken once, with no new review.
  if (go()) await tolerate(() => s.startSpecs());
  await tolerate(() => s.settled());
  if (go()) await tolerate(() => s.applySpecsSuggestions());
  await tolerate(() => s.settled());
  if (go() && (s.state.speckit?.status !== 'done' || s.state.speckit.stale)) {
    await tolerate(() => s.runPlans());
    await tolerate(() => s.settled());
  }
  if (!go()) return;
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
