import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import { outputContract } from '../orchestrator/steps.js';
import { PO_ITEMS, SM_ITEMS } from './checklist.js';
import { DOC_REL, flowTemplate, stackTemplate } from './draft.js';
import type { BacklogState, PatchRow, QuestionRow } from './state.js';
import type { JevValidationResult } from './jev-validation.js';

/** A stack.md or flow.md that is still the blank template is filled by the SM in one patch each; nobody is asked about a placeholder. */
function blankDocsRule(input: { role: 'po' | 'sm' | 'front'; stackMd?: string; flowMd?: string }, brief: string): string[] {
  if (input.role === 'front') return [];
  const blank = [input.stackMd === stackTemplate() ? 'docs/stack.md' : null, input.flowMd === flowTemplate() ? 'docs/flow.md' : null].filter((f): f is string => f !== null);
  if (blank.length === 0) return [];
  if (input.role === 'po') return [`${blank.join(' and ')} still hold only the blank template: the SM fills them. Do not ask about them and do not patch them.`];
  return [
    `${blank.join(' and ')} still hold only the blank template. Do NOT ask the human about them: return one docPatch per blank file (file = the path above, find = its first line, replace = the complete filled document), derived from project.md and ${brief} and consistent with them. Keep the template's headings; flow.md keeps a Mermaid flowchart. Write the content in Brazilian Portuguese.`,
  ];
}

/** Backlog mode: the same checklist ids, read against the derived backlog instead of one spec. */
const BACKLOG_REVIEW_RULE = 'Backlog mode: the docs were broken into a prioritized backlog of specs (derived backlog below). Read the checklist ids against it: po.objectives-verifiable = every item has a scope someone can verify; po.scope-explicit = every section of flow.md and every objective of the briefing is covered and nothing outside the docs was invented; po.no-contradictions = priorities and dependencies agree with the docs, above all with explicit decisions written in briefing.md; sm.tasks-feasible = each item is deliverable in one run and the dependency order is feasible. Question or patch only what the human must decide; a priority decision the human gives is recorded as a docPatch to docs/briefing.md.';

/** Spec (refinement) §3.2 step 2: what PO and SM see on every cycle. */
export function refinePack(input: {
  role: 'po' | 'sm' | 'front';
  specHash: string;
  principles: readonly string[];
  specId: string;
  projectMd: string;
  briefMd: string;
  stackMd?: string;
  flowMd?: string;
  designMd?: string;
  /** `spec` is null in backlog mode, where the docs are broken into `backlog` instead of one spec. */
  derived: { project: Project; spec: Spec | null };
  backlog?: BacklogState | null;
  retrieval: readonly Hit[];
  history: readonly QuestionRow[];
  rejected: readonly PatchRow[];
  jevValidation?: JevValidationResult;
  /** Decision 2: criteria System 1 judged not ready; null or absent means no hint. */
  notReady?: readonly string[] | null;
  /** Backlog mode: the briefing is the target project's docs/briefing.md. */
  projectBriefing?: boolean;
}): ContextPackInput {
  const rel = (file: keyof typeof DOC_REL) => DOC_REL[file](input.specId, input.projectBriefing);
  const brief = input.projectBriefing ? 'briefing.md' : 'brief.md';
  const answered = input.history.filter((q) => q.status === 'answered').map((q) => `- [${q.role}] ${q.text}\n  answer: ${q.answer}`);
  const skipped = input.history.filter((q) => q.status === 'skipped').map((q) => `- [${q.role}] ${q.text}`);
  const rejected = input.rejected.map((p) => `- ${rel(p.file)}: "${p.find.slice(0, 80)}" → rejected${p.decision ? `: ${p.decision}` : ''}`);
  const ids = input.role === 'po' ? PO_ITEMS : input.role === 'sm' ? SM_ITEMS : [];
  const feedback = [
    `LANGUAGE (mandatory): write every question, checklist detail, patch reason, summary, and explanation 100% in Brazilian Portuguese, even when project.md, ${brief}, the acceptance criteria, or this prompt are in English. Never copy English sentences into a question; translate the idea. Keep only technical identifiers, JSON keys, file names, HTTP status codes, and checklist ids unchanged.`,
    `Review flow.md as the business and application flow contract. Check that create, validate, persist, list, search, detail, update, delete, error, health, and persistence flows agree with project.md and ${brief}. Ask a question or propose a patch when a flow is missing, ambiguous, or contradictory.`,
    `Treat design.md as the frontend source of truth. Validate distinctive web and mobile direction, responsive states, accessibility, keyboard focus, reduced motion, touch targets, and consistency with project.md, ${brief}, stack.md, and flow.md. Reject generic AI-looking UI choices and propose a precise patch when design.md is incomplete or contradictory. Write every new design.md heading, description, label, and patch reason in Brazilian Portuguese; preserve only technical identifiers, file names, code, and color tokens.`,
    ...(input.derived.spec ? [] : [BACKLOG_REVIEW_RULE]),
    ...blankDocsRule(input, brief),
    `Report exactly these checklist ids: ${ids.join(', ') || '(none; Front reports only design.md patches)'}.`,
    input.role === 'front'
      ? `Patch files: ${rel('design.md')} only. Do not ask questions; return an empty questions array. This is a review, not an implementation task: do not edit or create files, do not run skills, a browser or shell commands, and do not follow your implementation workflow. Read what you need, then reply with the single JSON object and nothing else.`
      : `Patch files: ${rel('project.md')}, ${rel('brief.md')}.`,
    `### ${rel('project.md')}`,
    input.projectMd,
    `### ${rel('brief.md')}`,
    input.briefMd,
    ...(input.stackMd ? ['### stack.md', input.stackMd] : []),
    ...(input.flowMd ? ['### flow.md (Mermaid)', input.flowMd] : []),
    ...(input.designMd ? ['### design.md (frontend source of truth)', input.designMd] : []),
    '### Jev preflight validation',
    input.jevValidation ? JSON.stringify(input.jevValidation, null, 2) : '(not available)',
    ...(input.notReady ? ['### System 1 readiness (decision 2, a hint)', input.notReady.length ? `Not ready: ${input.notReady.join(', ')}. Focus questions and patches on these; the other criteria were judged ready.` : 'Every acceptance criterion was judged ready.'] : []),
    '### derived project.json',
    JSON.stringify(input.derived.project, null, 2),
    ...(input.derived.spec
      ? ['### derived spec.json', JSON.stringify(input.derived.spec, null, 2)]
      : [
          '### derived backlog (the docs broken into prioritized specs; review it, do not rewrite it)',
          JSON.stringify({ epics: input.backlog?.epics ?? [], items: (input.backlog?.items ?? []).map(({ rank, ...item }) => ({ rank, ...item })) }, null, 2),
        ]),
    '### Answered questions (do not ask again)',
    answered.join('\n') || '(none)',
    '### Skipped questions',
    skipped.join('\n') || '(none)',
    '### Rejected patches (do not propose again)',
    rejected.join('\n') || '(none)',
  ].join('\n\n');
  return {
    kind: 'refine',
    role: input.role,
    specHash: input.specHash,
    principles: input.principles,
    outputContract: outputContract('refine'),
    criteria: input.derived.spec?.acceptanceCriteria ?? [],
    objectives: input.derived.spec?.objectives ?? input.backlog?.epics.map((e) => e.title) ?? [],
    retrieval: input.retrieval,
    feedback,
    budgetTokens: 24_000,
  };
}
