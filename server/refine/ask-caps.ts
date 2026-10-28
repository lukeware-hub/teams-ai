import type { JournalEvent } from './agreement.js';

/**
 * How many non-blocking questions one run may put to the owner (plan 106, measured in shadow). specify and clarify follow the
 * upstream plan templates; the rest follow the autonomy plan. Blocking questions are not capped yet.
 */
export const ASK_CAPS = { constitution: 0, specify: 3, clarify: 5, plan: 0, tasks: 0, stageReview: 3, round: 5 } as const;
export type AskScope = keyof typeof ASK_CAPS;

const SPECKIT_COMMANDS: readonly AskScope[] = ['constitution', 'specify', 'clarify', 'plan', 'tasks'];
const isSpeckitScope = (command: unknown): command is AskScope => SPECKIT_COMMANDS.includes(command as AskScope);

/** One run of the refinement that put questions to the owner: a plan command for one item, a stage review, or a full round. */
export interface AskedRun {
  scope: AskScope;
  key: string;
  questions: Array<{ questionId: string; blocking: boolean }>;
}

/**
 * The runs that asked the owner, read from the journal. A plan question counts once, on its first id, as the owner sees one
 * card per id; a stage review and a round count every question they journaled, as the reducer keeps them all.
 */
export function askedRuns(events: readonly JournalEvent[]): AskedRun[] {
  const onRecord = new Set<string>();
  const runs: AskedRun[] = [];
  for (const e of events) {
    const questions = (e.data.questions ?? []) as Array<{ questionId: string; blocking?: boolean }>;
    if (e.type === 'SPECKIT_STEP_DONE' && isSpeckitScope(e.data.command)) {
      const fresh = questions.filter((q) => !onRecord.has(q.questionId));
      fresh.forEach((q) => onRecord.add(q.questionId));
      if (fresh.length > 0) runs.push({ scope: e.data.command, key: `${String(e.data.command)}|${String(e.data.itemKey ?? '')}`, questions: fresh.map(toAsk) });
    } else if (e.type === 'REFINE_STAGE_REVIEWED' && questions.length > 0) {
      runs.push({ scope: 'stageReview', key: `${String(e.data.file)}|${String(e.data.cycle)}`, questions: questions.map(toAsk) });
    } else if (e.type === 'REFINE_EVALUATED' && questions.length > 0) {
      runs.push({ scope: 'round', key: String(e.data.cycle), questions: questions.map(toAsk) });
    }
  }
  return runs;
}

const toAsk = (q: { questionId: string; blocking?: boolean }) => ({ questionId: q.questionId, blocking: q.blocking === true });

/** One run against its cap: how many questions it asked, and how many non-blocking ones go beyond the cap. */
export interface CapCount {
  scope: AskScope;
  key: string;
  asked: number;
  blocking: number;
  nonBlocking: number;
  excess: number;
}

export function capCounts(runs: readonly AskedRun[]): CapCount[] {
  return runs.map((r) => {
    const blocking = r.questions.filter((q) => q.blocking).length;
    const nonBlocking = r.questions.length - blocking;
    return { scope: r.scope, key: r.key, asked: r.questions.length, blocking, nonBlocking, excess: Math.max(0, nonBlocking - ASK_CAPS[r.scope]) };
  });
}

/** The printed lines of the shadow measurement: per scope, the runs, how many went over the cap, and the questions that would move. */
export function askCapLines(events: readonly JournalEvent[]): string[] {
  const counts = capCounts(askedRuns(events));
  const lines = ['ask caps (shadow, not enforced; blocking questions are not capped):'];
  for (const scope of Object.keys(ASK_CAPS) as AskScope[]) {
    const rows = counts.filter((c) => c.scope === scope);
    const over = rows.filter((c) => c.excess > 0).length;
    const nonBlocking = rows.reduce((sum, c) => sum + c.nonBlocking, 0);
    const excess = rows.reduce((sum, c) => sum + c.excess, 0);
    lines.push(`  ${scope.padEnd(12)} cap ${String(ASK_CAPS[scope]).padStart(1)}  runs ${String(rows.length).padStart(3)}  over ${String(over).padStart(3)}  non-blocking ${String(nonBlocking).padStart(4)}  would move ${String(excess).padStart(4)}`);
  }
  return lines;
}
