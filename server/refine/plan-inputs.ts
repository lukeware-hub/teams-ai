import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../contracts/hash.js';
import { OwnerError } from '../core/owner-error.js';
import { AgentFailure } from './agent-failure.js';
import { readDoc, type Draft } from './draft.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import type { QuestionRow, SpeckitStepFailure } from './state.js';
import { planItems, type PlanSource } from './plan-items.js';
import { renderSpecMd } from './spec-md.js';
import { renderSpecsMd } from './specs-md.js';

/** The six Markdown inputs every plan reads: the five documents and the specs index. */
export const PLAN_INPUTS = ['project.md', 'flow.md', 'briefing.md', 'stack.md', 'design.md', 'specs.md'] as const;
export type PlanInput = (typeof PLAN_INPUTS)[number];

/** The folder a preparation writes its plans in; publishing copies them into the draft docs. */
export const planStagingDir = (draft: Pick<Draft, 'root'>): string => path.posix.join(draft.root, 'speckit');
/** Where the six inputs go: beside the staging folder, so they are never published. */
export const planInputDir = (draft: Pick<Draft, 'root'>): string => path.posix.join(draft.root, 'speckit-input');

/** The acceptance criteria an item's plan keeps: its backlog spec's, or the single spec's. */
export const criteriaOf = (source: PlanSource, key: string) => (source.backlog?.enabled ? source.backlog.specs?.[key]?.spec : source.derived?.spec)?.acceptanceCriteria ?? [];

/** specs.md: the backlog's items, or the single spec as the section of its one item, with the spec's own headings one level down. */
function specsMdOf(draftId: string, source: PlanSource): string {
  if (source.backlog?.enabled) return renderSpecsMd(draftId, source.backlog);
  const [item] = planItems(draftId, source);
  const body = renderSpecMd(source.derived!.spec).split('\n').slice(1).map((line) => (line.startsWith('#') ? `#${line}` : line));
  return ['# Specs', '', `## ${item!.key}: ${item!.title}`, ...body].join('\n');
}

/** The text of the six Markdown inputs, as the plan steps read them. */
export async function planInputTexts(draft: Draft, source: PlanSource): Promise<Record<PlanInput, string>> {
  return {
    'project.md': await readDoc(draft, 'project.md'),
    'flow.md': await readDoc(draft, 'flow.md'),
    'briefing.md': await readDoc(draft, 'briefing.md'),
    'stack.md': await readDoc(draft, 'stack.md'),
    'design.md': await readDoc(draft, 'design.md'),
    'specs.md': specsMdOf(draft.specId, source),
  };
}

/** The hash of the six inputs, which a preparation records so the start can tell whether they changed. */
export const planInputsHash = (texts: Record<PlanInput, string>): string => sha256(PLAN_INPUTS.map((file) => texts[file]).join('\n'));

/** The hash of the six inputs as they are now, which the start compares with the one the last preparation read. */
export async function planInputHash(draft: Draft, source: PlanSource): Promise<string> {
  return planInputsHash(await planInputTexts(draft, source));
}

/** Writes the six Markdown inputs into a fresh input folder. */
export async function writePlanInputs(draft: Draft, texts: Record<PlanInput, string>): Promise<void> {
  const dir = planInputDir(draft);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(PLAN_INPUTS.map((file) => fs.writeFile(path.posix.join(dir, file), texts[file])));
}

export const PREPARATION_STAGE = 'A preparação dos planos';

/** A preparation whose item steps stopped: the reason is the first failure, and every failure is listed. */
export class PreparationFailed extends OwnerError {
  constructor(readonly failures: readonly SpeckitStepFailure[]) {
    super(failures.length > 1 ? `${failures[0]!.reason} Outros ${failures.length - 1} passo(s) também pararam.` : failures[0]!.reason, failures[0]!.detail);
  }
}

/** The kind a stopped preparation gives the heal driver: its agent failure's kind, or the kind every failed step shares. */
export function stopKindOf(err: unknown): FailureKind | undefined {
  if (err instanceof AgentFailure) return err.failure;
  if (!(err instanceof PreparationFailed)) return undefined;
  const kinds = new Set(err.failures.map((f) => f.failure));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/** The earlier questions of an item, the latest answer first, one per line with its state. */
export function questionLedger(rows: readonly QuestionRow[]): string {
  const latest = [...rows].sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? ''));
  return latest.slice(0, 40).map((q) => `- [${q.role}] ${q.text}\n  id ${q.questionId}: ${ledgerState(q)}`).join('\n') || '(none)';
}

/** What the journal says about one earlier question: its answer, who gave it and when. */
const ledgerState = (q: QuestionRow): string => {
  if (q.status === 'pending') return 'open, waiting for the owner';
  if (q.status === 'skipped') return 'skipped by the owner';
  const by = q.answeredBy ? `the ${q.answeredBy.toUpperCase()}` : 'the owner';
  return `answered by ${by}${q.answeredAt ? ` on ${q.answeredAt}` : ''}: ${q.answer}`;
};

/** The note of a step that runs again on the files of its earlier run, which are already in the staging folder. */
export const ADJUST_NOTE = `- Its files from an earlier run are already in this folder: read them first, keep what is still right, and change only what the owner's decisions and the changed documents require. Never copy the template over them, and never rewrite a plan from scratch.`;
