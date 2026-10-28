import { DOC_STAGES } from '@server/refine/doc-stages';
import type { PatchRow, QuestionRow, Snapshot } from '../api.js';
import type { StepperStep } from '../components/Stepper.js';
import { DOC_LABEL } from './doc-labels.js';

type State = Snapshot['state'];
type DocFile = (typeof DOC_STAGES)[number];

/** One screen per document, then the final review, then the backlog. */
export type WizardStep = DocFile | 'review' | 'backlog';
export const WIZARD_STEPS: readonly WizardStep[] = [...DOC_STAGES, 'review', 'backlog'];

export const isDocStep = (step: WizardStep): step is DocFile => step !== 'review' && step !== 'backlog';

/** The step as the address writes it: the document name, `revisao` for the review, `backlog` for the backlog. */
export const stepParam = (step: WizardStep): string => (step === 'review' ? 'revisao' : step);

export function parseStep(value: string | null): WizardStep | null {
  if (value === 'revisao') return 'review';
  if (value === 'backlog') return 'backlog';
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

export const prevStep = (step: WizardStep): WizardStep | null => WIZARD_STEPS[WIZARD_STEPS.indexOf(step) - 1] ?? null;
export const nextStep = (step: WizardStep): WizardStep | null => WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + 1] ?? null;

/** The stepper's nodes: state only, never a score. A stage session reads done from the journal; a project with no stages reads it from the position. */
export function wizardNodes(st: Pick<State, 'stages' | 'doneStages' | 'outdatedDocs' | 'staleBy' | 'reviewClosed'>, current: WizardStep): StepperStep[] {
  const done = new Set(st.doneStages ?? []);
  const at = WIZARD_STEPS.indexOf(current);
  return WIZARD_STEPS.map((step, index) => {
    const doc = isDocStep(step) ? step : null;
    const outdated = doc !== null && (st.outdatedDocs?.includes(doc) === true || st.staleBy?.[doc] !== undefined);
    const isDone = (doc !== null && (st.stages === true ? done.has(doc) : index < at)) || (step === 'review' && st.reviewClosed === true);
    return {
      key: step,
      label: doc ? DOC_LABEL[doc] : step === 'review' ? 'Revisão' : 'Backlog',
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
