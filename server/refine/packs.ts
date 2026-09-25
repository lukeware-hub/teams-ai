import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import { outputContract } from '../orchestrator/steps.js';
import { PO_ITEMS, SM_ITEMS } from './checklist.js';
import { DOC_REL } from './draft.js';
import type { PatchRow, QuestionRow } from './state.js';

/** Spec (refinement) §3.2 step 2: what PO and SM see on every cycle. */
export function refinePack(input: {
  role: 'po' | 'sm';
  specHash: string;
  principles: readonly string[];
  specId: string;
  projectMd: string;
  briefMd: string;
  stackMd?: string;
  flowMd?: string;
  derived: { project: Project; spec: Spec };
  retrieval: readonly Hit[];
  history: readonly QuestionRow[];
  rejected: readonly PatchRow[];
}): ContextPackInput {
  const answered = input.history.filter((q) => q.status === 'answered').map((q) => `- [${q.role}] ${q.text}\n  answer: ${q.answer}`);
  const skipped = input.history.filter((q) => q.status === 'skipped').map((q) => `- [${q.role}] ${q.text}`);
  const rejected = input.rejected.map((p) => `- ${DOC_REL[p.file](input.specId)}: "${p.find.slice(0, 80)}" → rejected${p.decision ? `: ${p.decision}` : ''}`);
  const ids = input.role === 'po' ? PO_ITEMS : SM_ITEMS;
  const feedback = [
    'Write every user-facing question, checklist detail, patch reason, and explanation in Brazilian Portuguese. Keep technical identifiers, file names, HTTP status codes, and checklist ids unchanged.',
    `Report exactly these checklist ids: ${ids.join(', ')}.`,
    `Patch files: ${DOC_REL['project.md'](input.specId)}, ${DOC_REL['brief.md'](input.specId)}.`,
    `### ${DOC_REL['project.md'](input.specId)}`,
    input.projectMd,
    `### ${DOC_REL['brief.md'](input.specId)}`,
    input.briefMd,
    ...(input.stackMd ? ['### stack.md', input.stackMd] : []),
    ...(input.flowMd ? ['### flow.md (Mermaid)', input.flowMd] : []),
    '### derived project.json',
    JSON.stringify(input.derived.project, null, 2),
    '### derived spec.json',
    JSON.stringify(input.derived.spec, null, 2),
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
    criteria: input.derived.spec.acceptanceCriteria,
    objectives: input.derived.spec.objectives,
    retrieval: input.retrieval,
    feedback,
    budgetTokens: 24_000,
  };
}
