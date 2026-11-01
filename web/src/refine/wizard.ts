import { DOC_STAGES } from '@server/refine/doc-stages';
import type { PatchRow, QuestionRow, Snapshot } from '../api.js';
import type { StepperStep } from '../components/Stepper.js';
import { DOC_LABEL } from './doc-labels.js';
import { stageOutdated } from './stage-view.js';

type State = Snapshot['state'];
type DocFile = (typeof DOC_STAGES)[number];

/** One screen per document, then the final review, then the backlog. */
export type WizardStep = DocFile | 'review' | 'architecture' | 'backlog';
export const WIZARD_STEPS: readonly WizardStep[] = [...DOC_STAGES, 'review', 'backlog'];
/** A repository session has the architecture step between the review and the backlog; any other draft keeps the steps above. */
export const stepsOf = (st: { repositories?: boolean }): readonly WizardStep[] => (st.repositories === true ? [...DOC_STAGES, 'review', 'architecture', 'backlog'] : WIZARD_STEPS);

export const isDocStep = (step: WizardStep): step is DocFile => step !== 'review' && step !== 'architecture' && step !== 'backlog';

/** The step as the address writes it: the document name, `revisao` for the review, `backlog` for the backlog. */
export const stepParam = (step: WizardStep): string => (step === 'review' ? 'revisao' : step === 'architecture' ? 'arquitetura' : step);

export function parseStep(value: string | null): WizardStep | null {
  if (value === 'revisao') return 'review';
  if (value === 'backlog') return 'backlog';
  if (value === 'arquitetura') return 'architecture';
  return (DOC_STAGES as readonly string[]).includes(value ?? '') ? (value as DocFile) : null;
}

/** The step named in the address, else the first document not done, else the review. A project that records no stages starts at the first document. */
export function initialStep(st: Pick<State, 'stages' | 'doneStages'>, param: string | null): WizardStep {
  const named = parseStep(param);
  if (named) return named;
  if (st.stages !== true) return DOC_STAGES[0];
  const done = new Set(st.doneStages ?? []);
  return DOC_STAGES.find((file) => !done.has(file)) ?? 'review';
}

export const prevStep = (step: WizardStep, steps: readonly WizardStep[] = WIZARD_STEPS): WizardStep | null => steps[steps.indexOf(step) - 1] ?? null;
export const nextStep = (step: WizardStep, steps: readonly WizardStep[] = WIZARD_STEPS): WizardStep | null => steps[steps.indexOf(step) + 1] ?? null;

/** The stepper's nodes: state only, never a score. A stage session reads done from the journal; a project with no stages reads it from the position. */
export function wizardNodes(st: Pick<State, 'stages' | 'doneStages' | 'graphed' | 'staleBy' | 'reviewClosed' | 'repositories' | 'architecture'>, current: WizardStep): StepperStep[] {
  const done = new Set(st.doneStages ?? []);
  const steps = stepsOf(st);
  const at = steps.indexOf(current);
  return steps.map((step, index) => {
    const doc = isDocStep(step) ? step : null;
    const outdated = doc !== null && stageOutdated(st, doc);
    const isDone = (doc !== null && (st.stages === true ? done.has(doc) : index < at)) || (step === 'review' && st.reviewClosed === true) || (step === 'architecture' && st.architecture != null);
    return {
      key: step,
      label: doc ? DOC_LABEL[doc] : step === 'review' ? 'Revisão' : step === 'architecture' ? 'Arquitetura' : 'Backlog',
      state: step === current ? 'active' : isDone ? 'done' : 'todo',
      ...(outdated ? { marker: 'desatualizado' } : {}),
    };
  });
}

const pendingQuestions = (st: Pick<State, 'questions'>) => st.questions.filter((q) => q.status === 'pending');

/** The pending questions a stage review asked about the document, blocking ones first. */
export const docQuestions = (st: Pick<State, 'questions'>, file: DocFile): QuestionRow[] =>
  pendingQuestions(st).filter((q) => q.file === file).sort((a, b) => Number(b.blocking) - Number(a.blocking));

/** The pending questions that name no document: the ones a full round asked. The plan preparation's belong to stage 7. */
export const unfiledQuestions = (st: Pick<State, 'questions'>): QuestionRow[] =>
  pendingQuestions(st).filter((q) => q.file === undefined && q.origin !== 'speckit').sort((a, b) => Number(b.blocking) - Number(a.blocking));

/** The pending questions the plan preparation asked while it prepared the development, blocking ones first. */
export const speckitQuestions = (st: Pick<State, 'questions'>): QuestionRow[] =>
  pendingQuestions(st).filter((q) => q.origin === 'speckit').sort((a, b) => Number(b.blocking) - Number(a.blocking));


export const docPatches = (st: Pick<State, 'patches'>, file: DocFile): PatchRow[] => st.patches.filter((p) => p.status === 'pending' && p.file === file);

export const pendingCount = (st: Pick<State, 'questions' | 'patches'>, file: DocFile): number => docQuestions(st, file).length + docPatches(st, file).length;
