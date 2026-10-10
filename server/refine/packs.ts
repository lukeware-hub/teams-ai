import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { estimateTokens, type ContextPackInput } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import { outputContract } from '../orchestrator/steps.js';
import { PO_ITEMS, SM_ITEMS } from './checklist.js';
import { coverageGaps } from './coverage.js';
import { DOC_REL, flowTemplate, stackTemplate } from './draft.js';
import type { BacklogState, PatchRow, QuestionRow } from './state.js';
import type { JevValidationResult } from './jev-validation.js';

/** A stack.md or flow.md that is still the blank template is filled by the SM in one patch each; nobody is asked about a placeholder. */
/** From the second cycle on a review converges: only defects block the spec (live: Front polished design.md for 8 cycles). */
const CONVERGENCE_RULE = 'CONVERGENCE (this is not the first cycle): propose a patch or question only for a defect that would make the implementation wrong or untestable - a contradiction, a rule an acceptance criterion needs but no document states, or a rule that would break the interface or its accessibility. Never propose wording, polish, or detail the implementation may choose on its own; when the documents are already implementable, return no patches and no questions.';

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

/** Detailed backlog: the review reads a digest of every spec and pre-plan, the gaps, and full JSON only for what changed. */
const DETAIL_REVIEW_RULE = 'Detailed backlog: every item has a spec (PO) and a pre-plan (SM), summarized below with the coverage gaps the orchestrator found; full JSON follows only for the items that changed this cycle. Read the checklist ids against them too: po.objectives-verifiable = every acceptance criterion is testable; sm.tasks-feasible = every pre-plan is deliverable and covers its criteria. Specs change only through the docs: to change one, record the decision in docs/briefing.md (or docs/project.md) through a docPatch, or ask the human; never patch a generated file. Put the AC ids a question is about in relatedAcIds.';

/** Up to this many tokens the review also carries the full JSON of the items that changed this cycle. */
const REVIEW_TOKENS = 100_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** About 350 tokens per item: the line the PO and SM review, its criteria and its pre-plan tasks. */
function backlogDigest(b: BacklogState): string {
  return [...b.items].sort((x, y) => x.rank - y.rank).map((i) => {
    const spec = b.specs?.[i.key];
    const pre = b.preplans?.[i.key];
    const status = !spec ? 'sem spec' : !spec.spec ? 'erro na spec' : pre?.preplan && pre.specRev === spec.rev ? 'planejada' : 'em refinamento';
    const lines = [`- [${i.rank}] ${i.priority} ${i.key}: ${i.title} (épico ${i.epic}; depende de: ${i.dependsOn.join(', ') || '-'}; fontes: ${i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}) — ${status}`];
    // A citation the docs no longer answer leaves the PO without its context: the review decides what to do with it.
    for (const s of spec?.spec?.derivedFrom?.sources ?? []) if (s.hash === null) lines.push(`  seção não encontrada: ${s.doc} › ${s.heading}`);
    for (const c of spec?.spec?.acceptanceCriteria ?? []) lines.push(`  ${c.id}${c.smoke ? ' (smoke)' : ''}: ${clip(`Given ${c.given}, when ${c.when}, then ${c.then}`, 100)}`);
    for (const t of pre?.preplan?.tasks ?? []) lines.push(`  ${t.id} [${t.criteriaRefs.join(', ')}] ${clip(t.title, 80)} · ${t.module}`);
    for (const issue of [...(spec?.issues ?? []), ...(pre?.issues ?? [])]) lines.push(`  problema: ${clip(issue, 160)}`);
    return lines.join('\n');
  }).join('\n');
}

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
  /** The cycle under review: a detailed backlog carries the full JSON of the items derived in it. */
  cycle?: number;
}): ContextPackInput {
  const detail = input.backlog?.detail === true && !input.derived.spec;
  const rel = (file: keyof typeof DOC_REL) => DOC_REL[file](input.specId, input.projectBriefing);
  const brief = input.projectBriefing ? 'briefing.md' : 'brief.md';
  const answered = input.history.filter((q) => q.status === 'answered').map((q) => `- [${q.role}] ${q.text}\n  answer: ${q.answer}`);
  const skipped = input.history.filter((q) => q.status === 'skipped').map((q) => `- [${q.role}] ${q.text}`);
  const rejected = input.rejected.map((p) => `- ${rel(p.file)}: "${p.find.slice(0, 80)}" → rejected${p.decision ? `: ${p.decision}` : ''}`);
  const ids = input.role === 'po' ? PO_ITEMS : input.role === 'sm' ? SM_ITEMS : [];
  const parts = [
    `LANGUAGE (mandatory): write every question, checklist detail, patch reason, summary, and explanation 100% in Brazilian Portuguese, even when project.md, ${brief}, the acceptance criteria, or this prompt are in English. Never copy English sentences into a question; translate the idea. Keep only technical identifiers, JSON keys, file names, HTTP status codes, and checklist ids unchanged.`,
    `Review flow.md as the business and application flow contract. Check that create, validate, persist, list, search, detail, update, delete, error, health, and persistence flows agree with project.md and ${brief}. Ask a question or propose a patch when a flow is missing, ambiguous, or contradictory.`,
    `Treat design.md as the frontend source of truth. Validate distinctive web and mobile direction, responsive states, accessibility, keyboard focus, reduced motion, touch targets, and consistency with project.md, ${brief}, stack.md, and flow.md. Reject generic AI-looking UI choices and propose a precise patch when design.md is incomplete or contradictory. Write every new design.md heading, description, label, and patch reason in Brazilian Portuguese; preserve only technical identifiers, file names, code, and color tokens.`,
    ...(input.derived.spec ? [] : [BACKLOG_REVIEW_RULE]),
    ...(detail ? [DETAIL_REVIEW_RULE] : []),
    ...blankDocsRule(input, brief),
    ...((input.cycle ?? 1) >= 2 ? [CONVERGENCE_RULE] : []),
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
      : detail
        ? ['### derived backlog (digest: each item, its criteria and its pre-plan tasks)', backlogDigest(input.backlog!), '### Coverage gaps', coverageGaps(input.backlog!).map((g) => `- ${g}`).join('\n') || '(none)']
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
  ];
  let feedback = parts.join('\n\n');
  if (detail) {
    // Full JSON of the items derived this cycle, by rank, while the review stays under REVIEW_TOKENS.
    const b = input.backlog!;
    const changed = [...b.items].sort((x, y) => x.rank - y.rank).filter((i) => b.specs?.[i.key]?.cycle === input.cycle || b.preplans?.[i.key]?.cycle === input.cycle);
    const blocks: string[] = [];
    for (const i of changed) {
      const block = JSON.stringify({ key: i.key, spec: b.specs?.[i.key]?.spec ?? null, preplan: b.preplans?.[i.key]?.preplan ?? null }, null, 2);
      if (estimateTokens(feedback) + estimateTokens(blocks.join('\n\n')) + estimateTokens(block) > REVIEW_TOKENS) break;
      blocks.push(block);
    }
    if (blocks.length > 0) feedback = [feedback, '### Items changed this cycle (full JSON)', ...blocks].join('\n\n');
  }
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
