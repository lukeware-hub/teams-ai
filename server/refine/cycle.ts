import type { AnswerOutput, BacklogOutput, DeriveOutput, OutputOf, RefineOutput, StepKind } from '../agents/outputs.js';
import type { z } from 'zod';
import type { Project } from '../contracts/project.js';
import type { AcceptanceCriterion, Spec } from '../contracts/spec.js';
import { loadSecrets } from '../core/secrets.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Journal } from '../orchestrator/events.js';
import type { Decider } from '../decide/decider.js';
import { contradictedChunks, duplicatePairs, duplicatePatches, notReadyCriteria } from '../decide/decisions/gate1.js';
import { routeQuestion } from '../decide/decisions/question-routing.js';
import type { AgentStepRequest } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import { mergeChecklist, type ChecklistItem } from './checklist.js';
import { derivePack, postProcessDerived } from './derive.js';
import { answerPack } from './answer.js';
import { backlogPack, postProcessBacklog, renderBacklogMd, type BacklogCheck } from './backlog.js';
import { fitPackBudget, PackTooLargeError } from './fit-pack.js';
import { sha256 } from '../contracts/hash.js';
import { flowHeadings } from '../validators/backlog.js';
import { flowIsMermaid } from './sections.js';
import { detailBacklog, maxCriterionInDraft, removeRetired } from './detail-cycle.js';
import { DOC_REL, draftHash, flowTemplate, keepBaseProject, readDerived, readDoc, stackTemplate, writeBacklogMd, writeDerived, writeDoc, writeProject, writeSpecsIndex, type DocFile, type Draft } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import { buildSpecsIndex } from './specs-index.js';
import type { JevValidationResult, ValidationDocs } from './jev-validation.js';
import { refinePack } from './packs.js';
import { applyPatch, checkPatch, patchId, unifiedDiff } from './patches.js';
import { applyRefineEvent, type BacklogState, type RefineState } from './state.js';

export type RunAgent = <K extends StepKind>(
  req: AgentStepRequest<K>,
  ctx: { journal: Pick<Journal, 'allocStepSeq' | 'fact'>; stepDir: (seq: number) => string; specHash: string; signal?: AbortSignal },
) => Promise<StepOutcome<OutputOf<K>>>;

export interface CycleJournal extends Pick<Journal, 'allocStepSeq' | 'fact'> {
  readonly state: RefineState;
}

export interface CycleDeps {
  draft: Draft;
  journal: CycleJournal;
  runAgent: RunAgent;
  frontAgent?: RunAgent;
  principles: () => readonly string[];
  retrieval: (query: string) => readonly Hit[];
  secretsDir: string;
  validateDocs?: (docs: ValidationDocs) => Promise<JevValidationResult>;
  /** Spec 10A.5 decisions 2–4; absent (or the layer off) leaves the cycle as it was. */
  decider?: Pick<Decider, 'decide'>;
  /** Aborting kills the agent steps this cycle has running. */
  signal?: AbortSignal;
  /** R11.5.7: the measured confidence floor for answering a question routed `auto` from the docs; unset leaves every question with the human. */
  autoAnswerFloor?: number;
}

const MAX_DEDUP_PAIRS = 20;
const MAX_HISTORY_CHUNKS = 5;
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Journals every decision the wrapped decider answers as DECISION_MADE (spec 10A.4), so evals can read Gate 1 too. */
function recorded(decider: Pick<Decider, 'decide'>, journal: Pick<Journal, 'fact'>, cycle: number): Pick<Decider, 'decide'> {
  return {
    decide: async (id, state, questions, ctx) => {
      const started = Date.now();
      const outcome = await decider.decide(id, state, questions, ctx);
      const record = outcome.answered
        ? { decisionId: id, backend: outcome.backend, escalated: outcome.escalated, answers: outcome.answers, durationMs: Date.now() - started }
        : { decisionId: id, backend: null, escalated: false, answers: null, durationMs: Date.now() - started, unanswered: outcome.reason };
      await journal.fact(RefineEvent.DecisionMade, { cycle, record });
      return outcome;
    },
  };
}

const BLANK_FILES = ['stack.md', 'flow.md'] as const;
const BLANK_TEMPLATE: Record<(typeof BLANK_FILES)[number], () => string> = { 'stack.md': stackTemplate, 'flow.md': flowTemplate };

/** Spec (refinement) §3.2: derive → Front → PO ∥ SM → merge questions → check patches → checklist. */
export async function runCycle(deps: CycleDeps, cycle: number): Promise<void> {
  try {
    await runCycleSteps(deps, cycle);
  } catch (err) {
    // Documents beyond the pack cap fail the cycle with a readable reason instead of reaching an agent without them.
    if (!(err instanceof PackTooLargeError)) throw err;
    await deps.journal.fact(RefineEvent.CycleFailed, { cycle, reason: err.message });
  }
}

async function runCycleSteps(deps: CycleDeps, cycle: number): Promise<void> {
  const { draft, journal } = deps;
  const decider = deps.decider ? recorded(deps.decider, journal, cycle) : undefined;
  const hash = await draftHash(draft);
  await journal.fact(RefineEvent.CycleStarted, { cycle, draftHash: hash });
  const ctx = { journal, stepDir: draft.steps, specHash: hash, signal: deps.signal };
  const docs: Record<DocFile, string> = {
    'project.md': await readDoc(draft, 'project.md'),
    'brief.md': await readDoc(draft, 'brief.md'),
    'stack.md': await readDoc(draft, 'stack.md'),
    'flow.md': await readDoc(draft, 'flow.md'),
    'design.md': await readDoc(draft, 'design.md'),
  };
  const previous = await readDerived(draft);
  const fail = (reason: string) => journal.fact(RefineEvent.CycleFailed, { cycle, reason });
  let jevValidation: JevValidationResult | undefined;
  if (deps.validateDocs) {
    jevValidation = await deps.validateDocs({ project: docs['project.md'], briefing: docs['brief.md'], stack: docs['stack.md'], flow: docs['flow.md'], design: docs['design.md'] }).catch(() => ({ available: false, decision: 'review' as const, consistent: null, confidence: null, model: null, checks: {}, stateTruncated: false }));
    const validation = jevValidation;
    await journal.fact(RefineEvent.DocsValidated, { cycle, backend: 'jev', ...validation });
    // Jev findings are advisory (passed to Claude, PO, and SM), but Jev itself is required: no agent runs without it.
    if (!validation.available) {
      await fail('Jev indisponível: confira a chave do OpenRouter.');
      return;
    }
  }

  const backlogMode = journal.state.backlog?.enabled === true;
  let derived: { project: Project; spec: Spec | null };
  let backlog: BacklogState | null = null;
  let criteria: readonly AcceptanceCriterion[] = [];
  let objectives: readonly string[] = [];
  let secretNames: string[] = [];
  if (backlogMode) {
    const before = journal.state.backlog;
    if (before?.project && before.items.length > 0 && before.draftHash === hash) {
      // The docs did not change since the outline was derived: asking again would only reword it.
      backlog = before;
    } else {
      // Backlog mode: the PO breaks the five docs into prioritized items instead of deriving one spec. One retry carries the rejection.
      let rejection: string[] | undefined;
      let accepted: Extract<BacklogCheck, { ok: true }> | null = null;
      for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
        const out = await deps.runAgent<'backlog'>(
          {
            kind: 'backlog',
            role: 'po',
            pack: fitPackBudget(backlogPack({ specHash: hash, principles: deps.principles(), projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'], previous: before, jevValidation, rejection })),
            cwd: draft.root,
            phase: 'refine',
            taskId: null,
            attempt: cycle,
          },
          ctx,
        );
        if (!out.ok) {
          await fail(`backlog failed: ${out.failure}: ${out.errors.join('; ')}`);
          return;
        }
        const checked = postProcessBacklog(out.value as BacklogOutput, before, docs['flow.md']);
        if (checked.ok) accepted = checked;
        else rejection = checked.issues;
      }
      if (!accepted) {
        await fail(`backlog: ${rejection!.join('; ')}`);
        return;
      }
      const { backlog: ranked } = accepted.value;
      const project = await keepBaseProject(draft, accepted.value.project);
      await writeProject(draft, project);
      await writeBacklogMd(draft, renderBacklogMd(ranked));
      await writeSpecsIndex(draft, buildSpecsIndex(draft.specId, { ...ranked, keyIds: before?.keyIds }));
      const outline = { cycle, project, epics: ranked.epics, items: ranked.items, flowHeadings: flowHeadings(docs['flow.md']), draftHash: hash };
      // Remove first: the outline event drops the rows that name the retired items' directories.
      await removeRetired(draft, before, ranked.items);
      await journal.fact(RefineEvent.BacklogDerived, outline);
      // The same merge the reducer makes: the detail of items that still exist carries over.
      const merged = { ...journal.state, backlog: before };
      applyRefineEvent(merged, { type: RefineEvent.BacklogDerived, data: outline });
      backlog = merged.backlog!;
    }
    if (backlog.detail) {
      const backlogDocs = { 'project.md': docs['project.md'], 'briefing.md': docs['brief.md'], 'stack.md': docs['stack.md'], 'flow.md': docs['flow.md'], 'design.md': docs['design.md'] };
      const detailed = await detailBacklog(deps, { cycle, hash, docs: backlogDocs, backlog, ctx });
      if (!detailed.ok) {
        await fail(detailed.reason);
        return;
      }
      backlog = detailed.backlog;
      secretNames = [...new Set(Object.values(backlog.specs ?? {}).flatMap((row) => row.spec?.externalDependencies.flatMap((dep) => dep.secretNames) ?? []))];
    }
    derived = { project: backlog.project!, spec: null };
    objectives = backlog.epics.map((e) => e.title);
  } else {
    const d = await deps.runAgent<'derive'>(
      {
        kind: 'derive',
        role: 'po',
        pack: fitPackBudget(derivePack({ specHash: hash, principles: deps.principles(), projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'], previous, specId: draft.specId, jevValidation })),
        cwd: draft.root,
        phase: 'refine',
        taskId: null,
        attempt: cycle,
      },
      ctx,
    );
    if (!d.ok) {
      await fail(`derive failed: ${d.failure}: ${d.errors.join('; ')}`);
      return;
    }
    // A sibling spec of the same project (copied into the draft from main) may already use higher ids (R11.8).
    const floor = await maxCriterionInDraft(draft);
    const checked = postProcessDerived(d.value as DeriveOutput, previous?.spec ?? null, draft.specId, floor);
    if (!checked.ok) {
      await fail(`derive: ${checked.issues.join('; ')}`);
      return;
    }
    checked.value.project = await keepBaseProject(draft, checked.value.project);
    await writeDerived(draft, checked.value);
    await journal.fact(RefineEvent.Derived, { cycle, ...checked.value });
    derived = checked.value;
    criteria = checked.value.spec.acceptanceCriteria;
    objectives = checked.value.spec.objectives;
    secretNames = checked.value.spec.externalDependencies.flatMap((dep) => dep.secretNames);
  }
  const dctx = { confidential: derived.project.confidential };
  const notReady = !backlogMode && deps.decider ? await notReadyCriteria(criteria, decider!, dctx) : null;

  const discardedPatches: Array<{ role: string; file: string; reason: string }> = [];
  if (deps.frontAgent) {
    const review = await deps.frontAgent({ kind: 'refine', role: 'front',
      pack: fitPackBudget(refinePack({ role: 'front', specHash: hash, principles: deps.principles(), specId: draft.specId,
        projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'],
        derived, backlog, retrieval: [], history: journal.state.questions,
        rejected: journal.state.patches.filter((p) => p.status === 'rejected'), jevValidation, projectBriefing: backlogMode, cycle })),
      cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx);
    if (!review.ok) { await fail(`front validation failed: ${review.failure}: ${review.errors.join('; ')}`); return; }
    let i = 0;
    for (const p of (review.value as z.infer<typeof RefineOutput>).docPatch) {
      const c = checkPatch(p, draft.specId, docs, backlogMode);
      if (!c.ok) {
        discardedPatches.push({ role: 'front', file: p.file, reason: c.reason });
        continue;
      }
      if (c.file !== 'design.md') {
        discardedPatches.push({ role: 'front', file: p.file, reason: 'Front só pode alterar design.md' });
        continue;
      }
      const after = applyPatch(docs[c.file], p)!;
      await journal.fact(RefineEvent.PatchProposed, {
        patchId: patchId('front', cycle, i++), role: 'front', file: c.file, find: p.find, replace: p.replace,
        reason: p.reason, diff: unifiedDiff(c.file, docs[c.file], after), cycle,
      });
    }
  }

  const state = journal.state;
  const retrieval = backlogMode ? [] : deps.retrieval(objectives.join(' '));
  const step = (role: 'po' | 'sm') =>
    deps.runAgent<'refine'>(
      {
        kind: 'refine',
        role,
        pack: fitPackBudget(refinePack({
          role,
          specHash: hash,
          principles: deps.principles(),
          specId: draft.specId,
          projectMd: docs['project.md'],
          briefMd: docs['brief.md'],
          stackMd: docs['stack.md'],
          flowMd: docs['flow.md'],
          designMd: docs['design.md'],
          derived,
          backlog,
          retrieval,
          history: state.questions,
          rejected: state.patches.filter((p) => p.status === 'rejected'),
          jevValidation,
          notReady,
          projectBriefing: backlogMode,
          cycle,
        })),
        cwd: draft.root,
        phase: 'refine',
        taskId: null,
        attempt: cycle,
      },
      ctx,
    );
  const [po, sm] = (await Promise.all([step('po'), step('sm')])) as [StepOutcome<z.infer<typeof RefineOutput>>, StepOutcome<z.infer<typeof RefineOutput>>];
  if (!po.ok) {
    await fail(`po refine failed: ${po.failure}: ${po.errors.join('; ')}`);
    return;
  }
  if (!sm.ok) {
    await fail(`sm refine failed: ${sm.failure}: ${sm.errors.join('; ')}`);
    return;
  }

  // Spec §3.2 step 3: dedup by normalized text, blocking first, PO before SM within a class.
  const decided = new Set(state.questions.filter((q) => q.status !== 'pending').map((q) => norm(q.text)));
  const seen = new Set<string>();
  const merged: Question[] = [];
  const counters = { po: 0, sm: 0 };
  for (const blocking of [true, false]) {
    for (const [role, out] of [['po', po.value], ['sm', sm.value]] as const) {
      for (const q of out.questions.filter((x) => x.blocking === blocking)) {
        const key = norm(q.text);
        if (seen.has(key) || decided.has(key)) continue;
        seen.add(key);
        merged.push({ questionId: `${role}-c${cycle}-${counters[role]++}`, role, text: q.text, blocking: q.blocking, relatedAcIds: q.relatedAcIds, cycle });
      }
    }
  }
  if (deps.decider) {
    // Decision 3: a new question that asks what an earlier one (new or decided) already asks, on a shared AC.
    const shares = (x: readonly string[], y: readonly string[]) => x.some((id) => y.includes(id));
    const earlier = [...state.questions.filter((q) => q.status !== 'pending'), ...merged];
    const pairs: Array<{ a: string; b: string; drop: Question }> = [];
    for (const q of merged) {
      for (const e of earlier) {
        if (pairs.length >= MAX_DEDUP_PAIRS) break;
        if (e === q) break; // only earlier questions: `merged` follows `decided` in `earlier`
        if (shares(e.relatedAcIds, q.relatedAcIds)) pairs.push({ a: e.text, b: q.text, drop: q });
      }
    }
    const dup = await duplicatePairs(pairs, decider!, dctx);
    const dropped = new Set(dup ? pairs.filter((_, i) => dup[i]).map((p) => p.drop) : []);
    for (let i = merged.length - 1; i >= 0; i--) if (dropped.has(merged[i]!)) merged.splice(i, 1);
    // Decision 4: history that the new spec contradicts becomes a blocking question for the human.
    const hits = retrieval.slice(0, MAX_HISTORY_CHUNKS);
    for (const i of await contradictedChunks(criteria, objectives, hits.map((h) => h.text), decider!, dctx)) {
      const h = hits[i]!;
      merged.push({ questionId: `po-c${cycle}-${counters.po++}`, role: 'po', text: `The new spec seems to contradict earlier project history (${h.title}${h.heading ? ` › ${h.heading}` : ''}): "${h.snippet}". Which one holds?`, blocking: true, relatedAcIds: [], cycle });
    }
  }
  // Plan 53 (R11.5a slice 1): a shadow-mode hint, off by default (`question-routing` disabled in config until an
  // eval exists). Never drops or answers a question; routed questions still reach the human exactly as before.
  const questionRouting: Record<string, { route: string; confidence: number | null }> = {};
  if (deps.decider) {
    const blocking = merged.filter((q) => q.blocking);
    const routed = await Promise.all(blocking.map((q) => routeQuestion(criteria, q.text, decider!, dctx)));
    blocking.forEach((q, i) => { const r = routed[i]; if (r) questionRouting[q.questionId] = { route: r.route, confidence: r.confidence }; });
  }

  // R11.10: PO and SM reading the same docs often propose the identical edit; accepting both would duplicate the
  // text. The first role to propose it (po, by iteration order) wins; a byte-identical later one is dropped.
  const proposedPatches = new Set<string>();
  const patchKey = (file: string, p: { find: string; replace: string }) => `${file}\u0000${p.find.trim()}\u0000${p.replace.trim()}`;
  // R11.5a item 2: a paraphrase of an already-accepted patch on the same file (same resulting content, different
  // wording), which the byte-identical check above cannot catch. One per file, so the comparison set stays small.
  const acceptedByFile = new Map<string, Array<{ find: string; replace: string }>>();
  for (const [role, out] of [['po', po.value], ['sm', sm.value]] as const) {
    let i = 0;
    for (const p of out.docPatch) {
      // A stack.md or flow.md that is still the blank template is filled by the SM straight away: nobody has anything
      // to review in a placeholder, and asking the human what to put there is the friction this avoids.
      const blank = role === 'sm' ? BLANK_FILES.find((f) => DOC_REL[f](draft.specId) === p.file && docs[f] === BLANK_TEMPLATE[f]()) : undefined;
      if (blank && p.replace.trim() !== '' && p.replace.trim() !== BLANK_TEMPLATE[blank]().trim()) {
        await writeDoc(draft, blank, p.replace);
        docs[blank] = await readDoc(draft, blank);
        await journal.fact(RefineEvent.DocEdited, { file: blank, hash: sha256(docs[blank]), source: 'autofill' });
        continue;
      }
      const c = checkPatch(p, draft.specId, docs, backlogMode);
      if (c.ok && c.file === 'design.md') {
        discardedPatches.push({ role, file: p.file, reason: 'design.md is reviewable only by front' });
        continue;
      }
      if (!c.ok) {
        discardedPatches.push({ role, file: p.file, reason: c.reason });
        continue;
      }
      const key = patchKey(c.file, p);
      if (proposedPatches.has(key)) {
        discardedPatches.push({ role, file: p.file, reason: 'the same change was already proposed this cycle' });
        continue;
      }
      const priorOnFile = acceptedByFile.get(c.file) ?? [];
      if (deps.decider && priorOnFile.length > 0) {
        const dup = await duplicatePatches(priorOnFile.map((a) => ({ a, b: p })), decider!, dctx);
        if (dup?.some((v) => v)) {
          discardedPatches.push({ role, file: p.file, reason: 'a near-duplicate of a patch already proposed this cycle (same change in substance)' });
          continue;
        }
      }
      proposedPatches.add(key);
      acceptedByFile.set(c.file, [...priorOnFile, { find: p.find, replace: p.replace }]);
      const after = applyPatch(docs[c.file], p)!;
      await journal.fact(RefineEvent.PatchProposed, {
        patchId: patchId(role, cycle, i++),
        role,
        file: c.file,
        find: p.find,
        replace: p.replace,
        reason: p.reason,
        diff: unifiedDiff(c.file, docs[c.file], after),
        cycle,
      });
    }
  }

  const checklist: ChecklistItem[] = mergeChecklist(po.value.checklist, sm.value.checklist);
  const present = await loadSecrets(deps.secretsDir);
  const missing = secretNames.filter((n) => !(n in present));
  const secretsItem = checklist.find((i) => i.id === 'sm.dependencies-and-secrets')!;
  // An outline lists no secrets yet (its specs will), so the SM's own judgement of the docs stands until detailing.
  if (!backlogMode || backlog?.detail) {
    secretsItem.passed = missing.length === 0;
    secretsItem.detail = missing.length === 0 ? 'every listed secret is present' : `missing secrets: ${missing.join(', ')}`;
  }
  const pendingBlocking = state.questions.filter((q) => q.status === 'pending' && q.blocking).length + merged.filter((q) => q.blocking).length;
  const openItem = checklist.find((i) => i.id === 'sm.no-open-questions')!;
  openItem.passed = pendingBlocking === 0;
  openItem.detail = pendingBlocking === 0 ? 'no blocking question open' : `${pendingBlocking} blocking question(s) open`;
  // R11.11: flow.md must be a mermaid diagram (the template already is); deterministic, not left to the SM's own say-so.
  const flowItem = checklist.find((i) => i.id === 'sm.flow-is-mermaid')!;
  flowItem.passed = flowIsMermaid(docs['flow.md']);
  flowItem.detail = flowItem.passed ? 'flow.md has a mermaid diagram' : 'flow.md has no ```mermaid block; it must be a diagram, not markdown headings';
  // The five documents must agree: a contradiction Jev finds fails the item whatever the PO reported.
  const consistent = jevValidation?.checks.documents_consistent;
  if (consistent !== undefined && consistent < 0.5) {
    const contradictionItem = checklist.find((i) => i.id === 'po.no-contradictions')!;
    contradictionItem.passed = false;
    contradictionItem.detail = 'o Jev encontrou divergência entre project.md, briefing.md, stack.md, flow.md e design.md';
  }
  await journal.fact(RefineEvent.Evaluated, { cycle, checklist, questions: merged, discardedPatches, questionRouting });
  // R11.5.7: a blocking question routed `auto` at the floor or above is answered by its owner role from the docs.
  const floor = deps.autoAnswerFloor;
  if (floor !== undefined) {
    for (const q of merged.filter((x) => x.blocking)) {
      const r = questionRouting[q.questionId];
      if (r?.route !== 'auto' || r.confidence === null || r.confidence < floor) continue;
      const out = (await deps.runAgent<'answer'>({ kind: 'answer', role: q.role, pack: answerPack({ specHash: hash, role: q.role, question: q.text, docs: { projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'] } }), cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx)) as StepOutcome<AnswerOutput>;
      if (out.ok && out.value.answer) await journal.fact(RefineEvent.QuestionAnswered, { questionId: q.questionId, text: out.value.answer, by: q.role });
    }
  }
}
