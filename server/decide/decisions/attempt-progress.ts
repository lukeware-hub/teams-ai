import type { PlanTask } from '../../contracts/plan.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 6. Levels are ordered low → high as a score question requires. */
export const ATTEMPT_PROGRESS_LEVELS = ['diverging', 'stalled', 'converging'] as const;
export type AttemptProgress = (typeof ATTEMPT_PROGRESS_LEVELS)[number];

export const ATTEMPT_PROGRESS_DEFAULT: AttemptProgress = 'converging';
const DELTA_CHARS = 3000;

export function attemptProgressQuestions(): Questions {
  return {
    progress: {
      type: 'score',
      instructions:
        'A developer agent has failed this task more than once. Each delta below is the feedback handed to the next attempt. Judge whether the attempts are diverging (new, unrelated failures each time), stalled (the same failure repeats) or converging (fewer or smaller failures each time).',
      levels: [...ATTEMPT_PROGRESS_LEVELS],
    },
  };
}

export function attemptProgressState(task: PlanTask, attempt: number, history: readonly string[]): string {
  const deltas = history.map((h, i) => `--- delta ${i + 1} ---\n${h.length > DELTA_CHARS ? h.slice(0, DELTA_CHARS) : h}`);
  return [`task: ${task.id}`, `title: ${task.title}`, `criteria: ${task.criteriaRefs.join(', ')}`, `attempt about to start: ${attempt}`, '', ...deltas].join('\n');
}

export interface ProgressResult {
  progress: AttemptProgress;
  source: 'default' | 'rule' | BackendName;
}

interface Finding {
  file: string;
  line: number | null;
  severity: string;
  text: string;
}

/** The findings above minor of a review delta, or null when the delta is not a review (a gate failure, say). */
function findings(delta: string): Finding[] | null {
  if (!delta.startsWith('Review requested changes:')) return null;
  return [...delta.matchAll(/^- (\S+?)(?::(\d+))? \[(\w+)\] (.*?)(?: \(fix: [\s\S]*?\))?$/gm)].filter((m) => m[3] !== 'minor').map((m) => ({ file: m[1]!, line: m[2] ? Number(m[2]) : null, severity: m[3]!, text: m[4]! }));
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-zà-ú_]{5,}/g) ?? []);

/** Share of the longer words two texts have in common, 0 to 1. */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const common = [...x].filter((w) => y.has(w)).length;
  return common / Math.max(1, x.size + y.size - common);
}

/** The same complaint: same file and severity, and the same spot (a whole-file finding, a line within 10, or a text saying much the same). Two findings in one file about different code are progress. */
function sameComplaint(x: Finding, y: Finding): boolean {
  return x.file === y.file && x.severity === y.severity && (x.line === null || y.line === null || Math.abs(x.line - y.line) <= 10 || overlap(x.text, y.text) >= 0.25);
}

/** The last attempt fixed nothing: every complaint of its delta was already in the delta before it (live: a file the orchestrator's commit kept dropping, flagged three times in a row; but a new problem in the same file, found once the first is fixed, is progress). */
export function repeatedFailure(history: readonly string[]): boolean {
  if (history.length < 2) return false;
  const last = history[history.length - 1]!;
  const before = history[history.length - 2]!;
  const now = findings(last);
  const then = findings(before);
  if (now === null || then === null) return now === null && then === null && last.trim() === before.trim();
  return now.length > 0 && now.every((x) => then.some((y) => sameComplaint(x, y)));
}

/** The weighted level index may fall between levels; round to the nearest one. */
export async function assessAttemptProgress(
  task: PlanTask,
  attempt: number,
  history: readonly string[],
  decider: Pick<Decider, 'decide'>,
  ctx: DecideContext,
): Promise<ProgressResult> {
  if (repeatedFailure(history)) return { progress: 'stalled', source: 'rule' };
  const outcome = await decider.decide('attempt-progress', attemptProgressState(task, attempt, history), attemptProgressQuestions(), ctx);
  if (!outcome.answered) return { progress: ATTEMPT_PROGRESS_DEFAULT, source: 'default' };
  const answer = outcome.answers.progress;
  if (!answer || answer.type !== 'score') return { progress: ATTEMPT_PROGRESS_DEFAULT, source: 'default' };
  const idx = Math.min(ATTEMPT_PROGRESS_LEVELS.length - 1, Math.max(0, Math.round(answer.value)));
  return { progress: ATTEMPT_PROGRESS_LEVELS[idx]!, source: outcome.backend };
}
