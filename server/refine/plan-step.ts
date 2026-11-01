import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SpeckitOutput } from '../agents/outputs.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import type { StepOutcome } from '../runner/step.js';
import { planFileOf } from './plan-file.js';
import { planShapeIssues } from './plan-shape.js';

/** How many times a plan that fails its shape runs again, with its problems named. */
export const MAX_PLAN_REPAIRS = 2;

export interface PlanStepRun {
  /** The folder the step writes in; the plan lands at `planFileOf(specId)` below it. */
  staging: string;
  specId: string;
  criteria: readonly string[];
  /** The file the step writes, relative to the folder; the implementation plan when absent. */
  file?: string;
  /** Checks the file's text and returns what is wrong with it; the plan shape check when absent. */
  check?: (text: string) => string[];
  /** The pack of one run; a repair run carries the note of the problems its previous plan had. */
  pack: (repair: string | null) => ContextPackInput;
  /** Runs the agent with a pack and returns its outcome. */
  run: (pack: ContextPackInput) => Promise<StepOutcome<SpeckitOutput>>;
}

export interface PlanStepResult {
  /** `valid`: the plan passes; `blocked`: the agent said it cannot write it; `failed`: the runner failed or the repairs ran out. */
  status: 'valid' | 'blocked' | 'failed';
  file: string;
  /** The problems of the last answer, or the reason it stopped. */
  issues: string[];
  /** Repair runs made after the first answer. */
  repairs: number;
  /** Questions the answers put to the owner; the step asks none. */
  questions: number;
}

/** The note a repair run reads: the problems of its previous plan, which this run fixes. */
export const planRepairNote = (file: string, issues: readonly string[]): string =>
  `The previous answer left these problems in ${file}, and the plan must not keep them:\n${issues.map((issue) => `- ${issue}`).join('\n')}\nFix them, keep everything else that is right, and answer again.`;

/** One plan step: runs the agent, checks the plan file it wrote, and repairs the plan up to MAX_PLAN_REPAIRS times. */
export async function runPlanStep(step: PlanStepRun): Promise<PlanStepResult> {
  const file = step.file ?? planFileOf(step.specId);
  const check = step.check ?? ((text: string) => planShapeIssues(text, step.criteria));
  let repair: string | null = null;
  for (let repairs = 0; ; repairs++) {
    const outcome = await step.run(step.pack(repair));
    if (!outcome.ok) return { status: 'failed', file, issues: outcome.errors, repairs, questions: 0 };
    const answer = outcome.value;
    const questions = answer.questions.length;
    if (answer.status === 'blocked') return { status: 'blocked', file, issues: [answer.reason], repairs, questions };
    const text = await fs.readFile(path.join(step.staging, file), 'utf8').catch(() => null);
    const issues = text === null ? [`the ${step.file === undefined ? 'plan file' : 'file'} ${file} is missing`] : check(text);
    if (issues.length === 0) return { status: 'valid', file, issues, repairs, questions };
    if (repairs === MAX_PLAN_REPAIRS) return { status: 'failed', file, issues, repairs, questions };
    repair = planRepairNote(file, issues);
  }
}
