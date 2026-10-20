import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import { estimateTokens, type ContextPackInput } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import { outputContract } from '../orchestrator/steps.js';
import { PO_ITEMS, SM_ITEMS } from './checklist.js';
import { coverageGaps, isStarted } from './coverage.js';
import { buildWithDocs, DIGEST_NOTE, docDigest, MAX_DOCS_TOKENS } from './docs-view.js';
import { DOC_REL, type DocFile, flowTemplate, stackTemplate } from './draft.js';
import type { BacklogState, FindingRow, MoveRow, PatchRow, QuestionRow } from './state.js';
import { jevHint, type JevValidationResult } from './jev-validation.js';

/** A stack.md or flow.md that is still the blank template is filled by the SM in one patch each; nobody is asked about a placeholder. */
/** From the second cycle on a review converges: only defects block the spec (live: Front polished design.md for 8 cycles). */
const CONVERGENCE_RULE = 'CONVERGENCE (this is not the first cycle): propose a patch or question only for a defect that would make the implementation wrong or untestable - a contradiction, a rule an acceptance criterion needs but no document states, or a rule that would break the interface or its accessibility. Never propose wording, polish, or detail the implementation may choose on its own; when the documents are already implementable, return no patches and no questions. A gap that carries a problema line (its spec or pre-plan failed to generate) is such a defect: ask it. An answer the owner gave is final: never ask again or ask to confirm it, and when it is short or delegates the choice, take the most conservative reading instead of asking.';

function blankDocsRule(input: { role: 'po' | 'sm' | 'front'; stackMd?: string; flowMd?: string }, brief: string): string[] {
  if (input.role === 'front') return [];
  const blank = [input.stackMd === stackTemplate() ? 'docs/stack.md' : null, input.flowMd === flowTemplate() ? 'docs/flow.md' : null].filter((f): f is string => f !== null);
  if (blank.length === 0) return [];
  if (input.role === 'po') return [`${blank.join(' and ')} still hold only the blank template: the SM fills them. Do not ask about them and do not patch them.`];
  return [
    `${blank.join(' and ')} still hold only the blank template. Do NOT ask the human about them: return one docPatch per blank file (file = the path above, find = its first line, replace = the complete filled document), derived from project.md and ${brief} and consistent with them. Keep the template's headings; flow.md keeps a Mermaid flowchart. Write the content in Brazilian Portuguese.`,
  ];
}

/** po.no-contradictions: the five docs are compared pair by pair, so a fact that differs between two of them fails the id. */
const NO_CONTRADICTIONS_RULE = 'po.no-contradictions: compare every pair of project.md, briefing.md, stack.md, flow.md and design.md on the same fact (a version, a port, a service name, a persistence choice, a route, a persona, a limit). For each fact that differs, add one entry to `contradictions`: the fact, the file and the exact words of each side in `quote` (copied character for character from that document, never shortened with "..."), and in `fix` how to make the two agree. The orchestrator checks every quote and drops any it cannot find: mark the id failed only when you list at least one contradiction with both quotes, and leave out of the detail any divergence you cannot quote. Also return the same change as a docPatch whose reason starts with the fact, when the change belongs to project.md or the briefing.';

/** Backlog mode: the same checklist ids, read against the derived backlog instead of one spec. */
const BACKLOG_REVIEW_RULE = 'Backlog mode: the docs were broken into a prioritized backlog of specs (derived backlog below). Read the checklist ids against it: po.objectives-verifiable = every item has a scope someone can verify; po.scope-explicit = every section of flow.md and every objective of the briefing is covered and nothing outside the docs was invented; po.no-contradictions = the docs agree (rule above) and priorities and dependencies agree with them, above all with explicit decisions written in briefing.md; sm.tasks-feasible = each item is deliverable in one run and the dependency order is feasible. Question or patch only what the human must decide; the answers of the human reach docs/briefing.md through the orchestrator.';

/** R11.10: one heading per decision, so each item cites only the decisions it needs and a new one re-derives only those items. */
const DECISION_RULE = 'Record each decision as its own `### <subject>` heading under the `## Decisões` section of docs/briefing.md (add the section at the end when it is missing), with a subject no other heading of the docs uses and the decision below it; never add a decision as one more line of a shared list, since every item that cites a section is derived again whenever that section changes. Give every question a `subject`: 3 to 8 words in Brazilian Portuguese naming its topic, never a fact the documents may change. The orchestrator writes each answer the owner gives under that subject as its own heading there, so never propose a patch that records an answer again. When that section still holds lines of decisions, propose one patch that turns each of its lines into its own heading.';

/** Who owns what: PO, SM and Front read the same documents at the same time, so each stays inside its own area. */
const ROLE_OWNERSHIP = {
  po: 'PO owns what and why: objectives, personas, scope, acceptance criteria a test can verify, business rules, the owner\'s decisions, and contradictions between the documents (po.* checklist ids).',
  sm: 'SM owns how and in what order: stack and architecture limits, the split into services, whether flow.md can be built (states, events, order, dependencies), task feasibility, and filling a blank stack.md or flow.md (sm.* checklist ids).',
  front: 'Front owns design.md only: visual direction, tokens, responsiveness, accessibility and states. Front asks no questions.',
} as const;

/** The documents each role may patch: its own, and flow.md, which both review. A patch elsewhere is discarded; any role may move content instead. */
export const PATCH_FILES: Record<'po' | 'sm', readonly DocFile[]> = { po: ['project.md', 'brief.md', 'flow.md'], sm: ['stack.md', 'flow.md'] };

/** The roles that may patch a document, by name: the owners the discarded patch's reason names. */
export const patchOwners = (file: DocFile): string => (Object.keys(PATCH_FILES) as Array<'po' | 'sm'>).filter((role) => PATCH_FILES[role].includes(file)).join(' and ');

/** The roles that own each document: the ones whose review carries that document's findings. */
const DOC_OWNERS: Record<DocFile, ReadonlyArray<'po' | 'sm' | 'front'>> = { 'project.md': ['po'], 'brief.md': ['po'], 'stack.md': ['sm'], 'flow.md': ['po', 'sm'], 'design.md': ['front'] };

/** Any role may move content that sits in the wrong document; the move is applied at once and the owner can undo it. */
const MOVE_RULE = 'MOVES: content that sits in the wrong document is moved, not patched and not only reported. Do this first: read each of the five documents line by line against the document charter in your instructions, and move each piece that sits in the wrong one. An empty `moves` list is correct only when every line of every document belongs where it is. The four kinds to look for: a technology name or version outside stack.md (for example React, TypeScript, PostgreSQL or Node) moves to stack.md; a color, size, contrast value, spacing, font, or list of screens or portals outside design.md moves to design.md; a business rule or feature outside the briefing moves to the briefing, and a deadline, a limit or what is allowed is a business rule even when a step checks it; an order of steps, or a branch that picks the next step, outside flow.md moves to flow.md. Return one entry in `moves` per piece: `from` and `to` are document paths as listed above; `quote` is the whole lines to take out of `from`, copied character for character and found once in it; `text` is the same content for `to`, in that document style, keeping every fact, number and name: only the sentence form may change, and every word that names a place, a tool, a value or a name stays. A fact that conflicts with another document is never rewritten inside a move: the text moves as it is, and the conflict is reported on its own, so the text holds no remark about the move or about a conflict. `after` is an exact existing line of `to` to place the text below, or absent to append at the end; `reason` says why it belongs in `to`. Any role may move content between any two documents. A line that holds two kinds of content is not moved and not cut: its owner leaves the line as it is and reports the other part as a finding for the owner of that document, quoting its words exactly. A finding about a misplaced piece never replaces its move, and a piece that a pending question names in double quotes is not moved until the owner answers it. Move only a clear misplacement, never wording or polish, and never touch a decision under the decisions heading of the briefing. Moves are not held back by the convergence rule. Each move is applied at once and the owner can undo it, so keep moves small and at most 3 per review.';

const rolesRule = (role: 'po' | 'sm' | 'front') => `ROLES IN THIS REVIEW: PO, SM and Front read the same documents at the same time, and none sees what the others propose in this cycle. ${ROLE_OWNERSHIP.po} ${ROLE_OWNERSHIP.sm} ${ROLE_OWNERSHIP.front} You are the ${role.toUpperCase()}: ask or patch only inside what you own. A problem in another area belongs to the role that owns it, except content in the wrong document: any role may move that (MOVES below). A fact that differs between two documents is the PO's; something that cannot be built is the SM's.`;

/** Every role reads all five documents from its own point of view and reports what it sees outside its area as a finding. */
const FINDINGS_RULE = 'FINDINGS: read all five documents through your own lens, and report a defect in a document you do not own as an entry in `findings` (doc, severity blocking or advice, the exact quote copied character for character, the problem in text, and the fix). Report at most 3 findings per document, and only a defect that would make the implementation wrong or untestable. A finding never replaces the checklist ids of your own role.';

/** R11.10: before the detailing, PO and SM leave what a spec decides to the detailing; nothing else waits. */
const OUTLINE_REVIEW_RULE = 'Outline review (no spec yet): never ask about or patch a detail a spec decides, such as a status code, a message, a field, a validation or the content of an e-mail; the detailing settles it, so a missing detail fails no checklist id now, and this narrows the flow.md review and the Jev preflight notes. It never holds back a contradiction between the docs, a split into services the docs leave open, filling a blank stack.md or flow.md, or turning an older list of decisions into headings.';

/** Detailed backlog: the review reads a digest of every spec and pre-plan, the gaps, and full JSON only for what changed. */
const DETAIL_REVIEW_RULE = 'Detailed backlog: every item has a spec (PO) and a pre-plan (SM), summarized below with the coverage gaps the orchestrator found; full JSON follows only for the items that changed this cycle. Read the checklist ids against them too: po.objectives-verifiable = every acceptance criterion is testable, and checkable with what its own item and the items it depends on, directly or through others, deliver; sm.tasks-feasible = every pre-plan is deliverable and covers its criteria. Specs change only through the docs: to change one, record the decision in docs/briefing.md (or docs/project.md) through a docPatch, or ask the human; never patch a generated file. Put the AC ids a question is about in relatedAcIds. A criterion or task carrying content of another document (a visual rule, a technology, an order of steps) points to misplaced source text: move that text in the documents, never edit a generated spec. Each gap with a problema line is a blocking question for the human, naming the item key. An item marked entregue or em execução is frozen: its spec already started or was delivered, it has no pre-plan here, and it is never reviewed, questioned or patched.';

/** Up to this many tokens the review also carries the full JSON of the items that changed this cycle. */
const REVIEW_TOKENS = 100_000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** About 350 tokens per item: the line the PO and SM review, its criteria and its pre-plan tasks. */
function backlogDigest(b: BacklogState): string {
  return [...b.items].sort((x, y) => x.rank - y.rank).map((i) => {
    const spec = b.specs?.[i.key];
    const pre = b.preplans?.[i.key];
    const status = !spec ? 'sem spec' : !spec.spec ? 'erro na spec' : isStarted(spec.spec.status) ? (spec.spec.status === 'done' ? 'entregue' : 'em execução') : pre?.preplan && pre.specRev === spec.rev ? 'planejada' : 'em refinamento';
    const lines = [`- [${i.rank}] ${i.priority} ${i.key}: ${i.title} (épico ${i.epic}; depende de: ${i.dependsOn.join(', ') || '-'}; fontes: ${i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}) — ${status}`];
    // A citation the docs no longer answer leaves the PO without its context: the review decides what to do with it.
    for (const s of spec?.spec?.derivedFrom?.sources ?? []) if (s.hash === null) lines.push(`  seção não encontrada: ${s.doc} › ${s.heading}`);
    for (const c of spec?.spec?.acceptanceCriteria ?? []) lines.push(`  ${c.id}${c.smoke ? ' (smoke)' : ''}: ${clip(`Given ${c.given}, when ${c.when}, then ${c.then}`, 100)}`);
    for (const t of pre?.preplan?.tasks ?? []) lines.push(`  ${t.id} [${t.criteriaRefs.join(', ')}] ${clip(t.title, 80)} · ${t.module}`);
    for (const issue of [...(spec?.issues ?? []), ...(pre?.issues ?? [])]) lines.push(`  problema: ${clip(issue, 160)}`);
    return lines.join('\n');
  }).join('\n');
}

/** The reorganization pass: every line of a changed document is checked against the charter; the other documents are context only. */
const REORGANIZE_RULE = 'REORGANIZE: a full pass of the documents against the charter in your instructions. Read every line of each document marked "reorganize in full" and check it against the charter. A line in the wrong document is a move: `from` and `to` are document paths as listed below, `quote` is the whole lines to take out of `from`, copied character for character and found once in it, `text` is the same content for `to` keeping every fact, number and name, `after` is an exact existing line of `to` to place it below (or absent to append), and `reason` says why it belongs in `to`. A piece that fits two documents goes where the charter tie-break puts it. Ask a question with two or three `options` (the recommended one marked) and a `subject` only when the charter leaves its right place open. Never guess a move. A document marked as context is for reference only: take nothing out of it. Write every question, option, reason and subject in Brazilian Portuguese. Set every question\'s `blocking` to false, and return empty `checklist`, `docPatch`, `findings` and `contradictions`: this pass only moves and asks. An empty `moves` list is correct only when every line of every document marked "reorganize in full" belongs where it is.';

/** Groups the changed documents into calls: one call for all of them when they fit, else one call per document. */
export function reorganizeGroups(changed: readonly DocFile[], texts: Record<DocFile, string>): DocFile[][] {
  const tokens = changed.reduce((sum, file) => sum + estimateTokens(texts[file]), 0);
  return tokens <= MAX_DOCS_TOKENS ? [[...changed]] : changed.map((file) => [file]);
}

/** One reorganization call: `changed` in full, the other documents as a digest for context. */
export function reorganizePack(input: {
  specHash: string;
  principles: readonly string[];
  specId: string;
  projectMd: string;
  briefMd: string;
  stackMd?: string;
  flowMd?: string;
  designMd?: string;
  changed: readonly DocFile[];
  projectBriefing?: boolean;
}): ContextPackInput {
  const docs: Record<DocFile, string | undefined> = { 'project.md': input.projectMd, 'brief.md': input.briefMd, 'stack.md': input.stackMd, 'flow.md': input.flowMd, 'design.md': input.designMd };
  const sections = (Object.keys(docs) as DocFile[]).flatMap((file) => {
    const text = docs[file];
    if (text === undefined) return [];
    const path = DOC_REL[file](input.specId, input.projectBriefing);
    return input.changed.includes(file)
      ? [`### ${path} (reorganize in full)`, text]
      : [`### ${path} (context only, a digest)`, docDigest(text, 600)];
  });
  const feedback = [REORGANIZE_RULE, ...sections].join('\n\n');
  return {
    kind: 'refine',
    role: 'po',
    specHash: input.specHash,
    principles: input.principles,
    outputContract: outputContract('refine'),
    criteria: [],
    objectives: [],
    retrieval: [],
    feedback,
    budgetTokens: MAX_DOCS_TOKENS + 10_000,
  };
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
  /** Suggestions an earlier cycle made that still wait for the owner. */
  pending?: readonly PatchRow[];
  /** The findings the last cycle verified, from the state; each role sees the ones about its own documents. */
  findings?: readonly FindingRow[];
  /** Moves the owner undid: no role proposes them again. */
  undoneMoves?: ReadonlyArray<Pick<MoveRow, 'from' | 'to' | 'quote'>>;
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
  // A continued spec's decisions are answers too (R11.7.1).
  const recorded = (input.derived.spec?.decisions ?? []).map((d) => `- ${d.question}\n  answer: ${d.answer}`);
  const answered = [...recorded, ...input.history.filter((q) => q.status === 'answered').map((q) => `- [${q.role}] ${q.text}\n  answer: ${q.answer}`)];
  const skipped = input.history.filter((q) => q.status === 'skipped').map((q) => `- [${q.role}] ${q.text}`);
  const openQuestions = input.history.filter((q) => q.status === 'pending').map((q) => `- [${q.role}] ${q.text}`);
  const rejected = input.rejected.map((p) => `- ${rel(p.file)}: "${p.find.slice(0, 80)}" → rejected${p.decision ? `: ${p.decision}` : ''}`);
  const pending = (input.pending ?? []).map((p) => `- ${rel(p.file)}: "${p.find.slice(0, 80)}" → ${clip(p.reason, 120)}`);
  const undone = (input.undoneMoves ?? []).map((m) => `- ${rel(m.from)} → ${rel(m.to)}: "${m.quote.slice(0, 80)}"`);
  const findingLines = (input.findings ?? []).filter((f) => DOC_OWNERS[f.doc].includes(input.role)).map((f) => `- [${f.role}] ${f.doc} (${f.severity}): "${clip(f.quote, 120)}" → ${clip(f.text, 200)} Fix: ${clip(f.fix, 200)}`).join('\n');
  const ids = input.role === 'po' ? PO_ITEMS : input.role === 'sm' ? SM_ITEMS : [];
  const parts = (d: Record<'project' | 'brief' | 'stack' | 'flow' | 'design', string | undefined>, digested: boolean) => [
    `LANGUAGE (mandatory): write every question, checklist detail, patch reason, summary, and explanation 100% in Brazilian Portuguese, even when project.md, ${brief}, the acceptance criteria, or this prompt are in English. Never copy English sentences into a question; translate the idea. Keep only technical identifiers, JSON keys, file names, HTTP status codes, and checklist ids unchanged.`,
    MOVE_RULE,
    input.role === 'po'
      ? `Review flow.md as the business and application flow contract. Check that create, validate, persist, list, search, detail, update, delete, error, health, and persistence flows agree with project.md and ${brief}. Ask a question or propose a patch when a flow is missing, ambiguous, or contradictory.`
      : input.role === 'sm'
        ? `Review flow.md as something to build: its states, events, order and dependencies must be implementable as written. Ask a question or propose a patch when a step is missing or cannot be built.`
        : 'flow.md is context for you: do not review it.',
    ...(input.role === 'po' ? [NO_CONTRADICTIONS_RULE] : []),
    input.role === 'front'
      ? `Treat design.md as the frontend source of truth. Validate distinctive web and mobile direction, responsive states, accessibility, keyboard focus, reduced motion, touch targets, and consistency with project.md, ${brief}, stack.md, and flow.md. Reject generic AI-looking UI choices and propose a precise patch when design.md is incomplete or contradictory. A process order, business rule, endpoint or technology written in design.md is a move to the document that holds it, not a patch. A patch never replaces or deletes such a line, and never rewrites its meaning as visual wording. A visual value written in the briefing (a color, size or contrast) is a move to design.md too; a contrast conflict it causes is a finding on top of that move. Before a patch, read design.md as it stands now: a rule already written there, including a line moved into it in this cycle, is replaced, never written a second time. Write every new design.md heading, description, label, and patch reason in Brazilian Portuguese; preserve only technical identifiers, file names, code, and color tokens.`
      : `design.md is Front's: read it as context, never ask about it or patch it. Report it only as a contradiction with another document.`,
    rolesRule(input.role),
    FINDINGS_RULE,
    ...(input.derived.spec ? [] : [BACKLOG_REVIEW_RULE, ...(input.role === 'front' ? [] : [DECISION_RULE])]),
    ...(detail ? [DETAIL_REVIEW_RULE] : []),
    ...(input.derived.spec || detail || input.role === 'front' ? [] : [OUTLINE_REVIEW_RULE]),
    ...blankDocsRule(input, brief),
    ...((input.cycle ?? 1) >= 2 ? [CONVERGENCE_RULE] : []),
    `Report exactly these checklist ids: ${ids.join(', ') || '(none; Front reports only design.md patches)'}.`,
    input.role === 'front'
      ? `Patch files: ${rel('design.md')} only. Do not ask questions; return an empty questions array. This is a review, not an implementation task: do not edit or create files, do not run skills, a browser or shell commands, and do not follow your implementation workflow. Read what you need, then reply with the single JSON object and nothing else.`
      : `Patch files: ${PATCH_FILES[input.role].map((file) => rel(file)).join(', ')}.`,
    ...(digested ? [DIGEST_NOTE] : []),
    `### ${rel('project.md')}`,
    d.project,
    `### ${rel('brief.md')}`,
    d.brief,
    ...(input.stackMd ? ['### stack.md', d.stack] : []),
    ...(input.flowMd ? ['### flow.md (Mermaid)', d.flow] : []),
    ...(input.designMd ? ['### design.md (frontend source of truth)', d.design] : []),
    '### Jev preflight validation',
    jevHint(input.jevValidation),
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
    '### Open questions (waiting for the owner: do not ask again, not even reworded)',
    openQuestions.join('\n') || '(none)',
    '### Rejected patches (do not propose again)',
    rejected.join('\n') || '(none)',
    '### Moves the owner undid (do not propose them again)',
    undone.join('\n') || '(none)',
    '### Pending suggestions (already proposed, waiting for the owner: do not propose them again, not even reworded)',
    pending.join('\n') || '(none)',
    '### Findings about your documents from the other roles (each quote was checked against the document it names: fix it with a patch or a move, or say why not)',
    findingLines || '(none)',
  ];
  // A detailed backlog keeps room under REVIEW_TOKENS for the full JSON of the items that changed.
  let feedback = buildWithDocs({ project: input.projectMd, brief: input.briefMd, stack: input.stackMd, flow: input.flowMd, design: input.designMd }, (d, digested) => parts(d, digested).join('\n\n'), detail ? REVIEW_TOKENS - 20_000 : undefined);
  if (detail) {
    // Full JSON of the items derived this cycle, by rank, while the review stays under REVIEW_TOKENS.
    const b = input.backlog!;
    // A frozen spec (started or delivered) is never reviewed, so it never takes the changed items' budget.
    const changed = [...b.items].sort((x, y) => x.rank - y.rank).filter((i) => !isStarted(b.specs?.[i.key]?.spec?.status) && (b.specs?.[i.key]?.cycle === input.cycle || b.preplans?.[i.key]?.cycle === input.cycle));
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
