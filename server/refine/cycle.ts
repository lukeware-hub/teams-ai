import type { AnswerOutput, BacklogOutput, DeriveOutput, OutputOf, RefineOutput, StepKind } from '../agents/outputs.js';
import type { z } from 'zod';
import { Project } from '../contracts/project.js';
import { providedSecretNames, type AcceptanceCriterion, type Spec } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';
import { redactSecrets } from '../core/redact.js';
import { loadSecrets } from '../core/secrets.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Journal } from '../orchestrator/events.js';
import type { Decider } from '../decide/decider.js';
import { contradictedChunks, duplicatePairs, duplicatePatches, notReadyCriteria } from '../decide/decisions/gate1.js';
import { routeQuestion } from '../decide/decisions/question-routing.js';
import type { AgentStepRequest } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import { adjustmentsDue, approvalPatch, approvedAdjustments, isAdjustment, type DueAdjustment } from './adjustments.js';
import { mergeChecklist, type ChecklistItem } from './checklist.js';
import { norm, parseDecisions } from './decisions.js';
import { derivePack, postProcessDerived } from './derive.js';
import { answerPack } from './answer.js';
import { heldForOwner } from './auto-floor.js';
import { backlogPack, postProcessBacklog, renderBacklogMd, type BacklogCheck } from './backlog.js';
import { fitPackBudget, PackTooLargeError } from './fit-pack.js';
import { sha256 } from '../contracts/hash.js';
import { flowHeadings } from '../validators/backlog.js';
import { flowIsMermaid } from './sections.js';
import { uniqueHeadingFixes } from './heading-fixes.js';
import { detailBacklog, maxCriterionInDraft, retireDropped } from './detail-cycle.js';
import { isStarted } from './coverage.js';
import { DOC_REL, draftHash, flowTemplate, keepBaseProject, readBase, readDerived, readDoc, readMainSpec, stackTemplate, writeBacklogMd, writeDerived, writeDoc, writeProject, writeSpecsIndex, type DocFile, type Draft } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import { buildSpecsIndex, outlineOfIndex, specIdOf, type SpecsIndex } from './specs-index.js';
import type { JevValidationResult, ValidationDocs } from './jev-validation.js';
import { refinePack } from './packs.js';
import { applyPatch, checkPatch, patchId, unifiedDiff } from './patches.js';
import { applyRefineEvent, type BacklogState, type RefineState } from './state.js';

export type RunAgent = <K extends StepKind>(
  req: AgentStepRequest<K>,
  ctx: { journal: Pick<Journal, 'allocStepSeq' | 'fact'>; stepDir: (seq: number) => string; specHash: string; signal?: AbortSignal; /** Answer at once when the quota is paused instead of waiting for it (a person is at the screen). */ noQuotaWait?: boolean; /** The project whose agent settings apply to the step. */ projectId?: string },
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

/** Main's outline, from its specs.json in the base copy, for a new draft's first outline; the draft's own state when main has none. */
async function mainOutline(draft: Draft, before: BacklogState | null): Promise<BacklogState | null> {
  try {
    const index = JSON.parse((await readBase(draft, 'specs.json')) ?? 'null') as SpecsIndex | null;
    if (!index?.specs?.length) return before;
    // A file of the target repository whose keys become paths in the draft: one that is not a slug leaves main's outline out.
    if (!index.specs.every((s) => [s.specId, s.key, ...s.dependsOn].every((v) => typeof v === 'string' && ID_PATTERNS.SLUG.test(v)))) return before;
    return { ...(before ?? { enabled: true, project: null, cycle: 0 }), ...outlineOfIndex(index) } as BacklogState;
  } catch {
    return before;
  }
}

const MAX_DEDUP_PAIRS = 20;
const MAX_HISTORY_CHUNKS = 5;

/** Journals every decision the wrapped decider answers as DECISION_MADE (spec 10A.4), so evals can read Gate 1 too. */
function recorded(decider: Pick<Decider, 'decide'>, journal: Pick<Journal, 'fact'>, cycle: number): Pick<Decider, 'decide'> {
  return {
    decide: async (id, state, questions, ctx) => {
      const started = Date.now();
      const outcome = await decider.decide(id, state, questions, ctx);
      const record = outcome.answered
        ? { decisionId: id, backend: outcome.backend, escalated: outcome.escalated, answers: outcome.answers, durationMs: Date.now() - started }
        : { decisionId: id, backend: null, escalated: false, answers: null, durationMs: Date.now() - started, unanswered: outcome.reason, ...(outcome.reason === 'error' ? { error: outcome.message } : {}) };
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
    // Any error fails the cycle, so the session never stays in `evaluating`; documents beyond the pack cap are an expected failure.
    await deps.journal.fact(RefineEvent.CycleFailed, { cycle, reason: redactSecrets(err instanceof Error ? err.message : String(err)) });
    if (!(err instanceof PackTooLargeError)) throw err;
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
  // The five docs by the names backlog items cite them with.
  const backlogDocs = { 'project.md': docs['project.md'], 'briefing.md': docs['brief.md'], 'stack.md': docs['stack.md'], 'flow.md': docs['flow.md'], 'design.md': docs['design.md'] };
  const previous = await readDerived(draft);
  const fail = (reason: string) => journal.fact(RefineEvent.CycleFailed, { cycle, reason });
  let jevValidation: JevValidationResult | undefined;
  // A confidential project never sends its docs to the OpenRouter: Jev is skipped and the agents run without its findings.
  const confidential = previous?.project.confidential ?? Project.safeParse(JSON.parse((await readBase(draft, 'project.json')) ?? 'null')).data?.confidential ?? false;
  if (deps.validateDocs && confidential) {
    jevValidation = { available: true, decision: 'review', consistent: null, confidence: null, model: null, checks: {}, stateTruncated: false };
    await journal.fact(RefineEvent.DocsValidated, { cycle, backend: 'jev', ...jevValidation, skipped: 'confidential' });
  } else if (deps.validateDocs) {
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
  let due: DueAdjustment[] = [];
  if (backlogMode) {
    const before = journal.state.backlog;
    if (before?.project && before.items.length > 0 && before.draftHash === hash) {
      // The docs did not change since the outline was derived: asking again would only reword it.
      backlog = before;
    } else {
      // Backlog mode: the PO breaks the five docs into prioritized items instead of deriving one spec. One retry carries the rejection.
      // R11.7.3: a new draft's first outline starts from main's, so the PO keeps its keys and wording and unchanged items are reused.
      const last = before?.items.length ? before : await mainOutline(draft, before);
      // R11.7.4: adjustments are the orchestrator's: the PO never sees one, and each comes back from its approval in briefing.md.
      const previous = last && { ...last, items: last.items.filter((i) => !isAdjustment(i.key)) };
      const idOf = (key: string) => before?.specs?.[key]?.specId ?? specIdOf(draft.specId, key, before?.keyIds);
      // R11.7.5: an item of the last outline whose spec started on main stays even when the PO drops it.
      const started = (await Promise.all((last?.items ?? []).map(async (i) => (isStarted((await readMainSpec(draft, idOf(i.key)))?.status) ? [i] : [])))).flat();
      let rejection: string[] | undefined;
      let accepted: Extract<BacklogCheck, { ok: true }> | null = null;
      for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
        const out = await deps.runAgent<'backlog'>(
          {
            kind: 'backlog',
            role: 'po',
            pack: fitPackBudget(backlogPack({ specHash: hash, principles: deps.principles(), projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'], previous, jevValidation, rejection, started: started.map((i) => i.key) })),
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
        const checked = postProcessBacklog(out.value as BacklogOutput, previous, backlogDocs, approvedAdjustments(docs['brief.md']), started);
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
      const keys = new Set(ranked.items.map((i) => i.key));
      await retireDropped(draft, [...new Set([...Object.keys(before?.specs ?? {}), ...(last?.items ?? []).map((i) => i.key)])].filter((k) => !keys.has(k)).map(idOf));
      await journal.fact(RefineEvent.BacklogDerived, outline);
      // The same merge the reducer makes: the detail of items that still exist carries over.
      const merged = { ...journal.state, backlog: before };
      applyRefineEvent(merged, { type: RefineEvent.BacklogDerived, data: outline });
      backlog = merged.backlog!;
    }
    if (backlog.detail) {
      // The recorded decider journals the Jev's checks of the detailing (R11.5a item 3).
      const detailed = await detailBacklog({ ...deps, decider }, { cycle, hash, docs: backlogDocs, backlog, ctx });
      if (!detailed.ok) {
        await fail(detailed.reason);
        return;
      }
      backlog = detailed.backlog;
      secretNames = [...new Set(Object.values(backlog.specs ?? {}).flatMap((row) => providedSecretNames(row.spec?.externalDependencies ?? [])))];
      // R11.7.4: a started spec whose cited sections changed gets an adjustment for the owner to approve.
      due = adjustmentsDue(backlog, backlogDocs, journal.state.patches);
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
    const checked = postProcessDerived(d.value as DeriveOutput, previous?.spec ?? null, draft.specId, floor, parseDecisions(docs['brief.md']));
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
    secretNames = providedSecretNames(checked.value.spec.externalDependencies);
  }
  const dctx = { confidential: derived.project.confidential };
  const notReady = !backlogMode && deps.decider ? await notReadyCriteria(criteria, decider!, dctx) : null;

  const discardedPatches: Array<{ role: string; file: string; reason: string }> = [];
  if (deps.frontAgent) {
    const askFront = () => deps.frontAgent!({ kind: 'refine', role: 'front',
      pack: fitPackBudget(refinePack({ role: 'front', specHash: hash, principles: deps.principles(), specId: draft.specId,
        projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'],
        derived, backlog, retrieval: [], history: journal.state.questions,
        rejected: journal.state.patches.filter((p) => p.status === 'rejected'), pending: journal.state.patches.filter((p) => p.status === 'pending'), jevValidation, projectBriefing: backlogMode, cycle })),
      cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx);
    let review = await askFront();
    // The model now and then drops a required field of one suggestion. The suggestions are advice, so one more try, and then the cycle goes on without them instead of failing.
    if (!review.ok && review.failure === 'schema') review = await askFront();
    if (!review.ok && review.failure !== 'schema') { await fail(`front validation failed: ${review.failure}: ${review.errors.join('; ')}`); return; }
    if (!review.ok) discardedPatches.push({ role: 'front', file: 'design.md', reason: 'O agente Front respondeu fora do formato duas vezes, então as sugestões visuais deste ciclo foram puladas. Use Reavaliar para tentar de novo.' });
    let i = 0;
    for (const p of review.ok ? (review.value as z.infer<typeof RefineOutput>).docPatch : []) {
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

  // A repeated design.md heading makes a backlog item cite an ambiguous section: the human gets unique headings to accept, none one already pending or rejected.
  let fixIndex = journal.state.patches.filter((p) => p.cycle === cycle && p.role === 'front').length;
  for (const fix of uniqueHeadingFixes(docs['design.md'])) {
    if (journal.state.patches.some((p) => p.file === 'design.md' && p.find === fix.find && p.replace === fix.replace && (p.status === 'pending' || p.status === 'rejected'))) continue;
    await journal.fact(RefineEvent.PatchProposed, {
      patchId: patchId('front', cycle, fixIndex++), role: 'front', file: 'design.md', ...fix,
      diff: unifiedDiff('design.md', docs['design.md'], applyPatch(docs['design.md'], fix)!), cycle,
    });
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
          pending: state.patches.filter((p) => p.status === 'pending'),
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

  // Spec §3.2 step 3: dedup by normalized text, blocking first, PO before SM within a class; a decision counts as decided (R11.7.1).
  // A question still pending from an earlier cycle is not asked again.
  const decided = new Set([...state.questions.map((q) => q.text), ...(derived.spec?.decisions ?? []).map((d) => d.question)].map(norm));
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
  // The questions only the human can decide, which no role answers from the docs.
  const forHuman = new Set<string>();
  if (deps.decider) {
    // Decision 3: a new question that asks what an earlier one (new, pending or decided) already asks, on a shared AC.
    const shares = (x: readonly string[], y: readonly string[]) => x.some((id) => y.includes(id));
    const earlier = [...state.questions, ...merged];
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
      const id = `po-c${cycle}-${counters.po++}`;
      forHuman.add(id);
      merged.push({ questionId: id, role: 'po', text: `The new spec seems to contradict earlier project history (${h.title}${h.heading ? ` › ${h.heading}` : ''}): "${h.snippet}". Which one holds?`, blocking: true, relatedAcIds: [], cycle });
    }
  }
  // R11.5.7: the route of each blocking question, journaled for the eval; it answers only at the floor the config fixes or the labels prove.
  const questionRouting: Record<string, { route: string; confidence: number | null; source: string }> = {};
  if (deps.decider) {
    // A question only the human decides is never answered on its own, so routing it would only spend a Jev call.
    const blocking = merged.filter((q) => q.blocking && !forHuman.has(q.questionId));
    const routed = await Promise.all(blocking.map((q) => routeQuestion(criteria, q.text, decider!, dctx)));
    blocking.forEach((q, i) => { const r = routed[i]; if (r) questionRouting[q.questionId] = { route: r.route, confidence: r.confidence, source: r.source }; });
  }

  // R11.10: PO and SM reading the same docs often propose the identical edit; accepting both would duplicate the
  // text. The first role to propose it (po, by iteration order) wins; a byte-identical later one is dropped.
  const proposedPatches = new Set<string>();
  const patchKey = (file: string, p: { find: string; replace: string }) => `${file}\u0000${p.find.trim()}\u0000${p.replace.trim()}`;
  // Earlier cycles' suggestions still wait for the owner: proposing one again would only pile up copies of it.
  const stillPending = new Set(state.patches.filter((p) => p.status === 'pending').map((p) => patchKey(p.file, p)));
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
      if (stillPending.has(key)) {
        discardedPatches.push({ role, file: p.file, reason: 'the same change is already waiting for the owner' });
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

  // R11.7.4: accepting the patch approves the adjustment; rejecting it keeps the started spec as it is.
  let next = state.patches.filter((p) => p.cycle === cycle && p.role === 'po').length;
  for (const a of due) {
    const p = approvalPatch(a);
    await journal.fact(RefineEvent.PatchProposed, { patchId: patchId('po', cycle, next++), role: 'po', file: 'brief.md', ...p, diff: unifiedDiff('brief.md', docs['brief.md'], applyPatch(docs['brief.md'], p)!), cycle });
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
  // The Jev only warns: its doubt goes into the item's detail, and the PO's verdict stands.
  const consistent = jevValidation?.checks.documents_consistent;
  if (consistent !== undefined && consistent < 0.5) {
    const contradictionItem = checklist.find((i) => i.id === 'po.no-contradictions')!;
    contradictionItem.detail = `${contradictionItem.detail} Aviso do Jev (automático, pode errar, não bloqueia): duvidou da consistência (${consistent.toFixed(2).replace('.', ',')}).`;
  }
  // R11.5.7: a blocking question routed `auto` at the floor or above is answered by its owner role from the docs, before the
  // evaluation is journaled, so the page shows the cycle running until the answers land with it.
  const floor = deps.autoAnswerFloor;
  const eligible = floor === undefined ? [] : merged.filter((q) => {
    const r = questionRouting[q.questionId];
    return q.blocking && !forHuman.has(q.questionId) && !heldForOwner(q.questionId) && r?.route === 'auto' && r.source === 'jev' && r.confidence !== null && r.confidence >= floor;
  });
  const answers = await Promise.all(eligible.map(async (q) => {
    if (deps.signal?.aborted) return null;
    const pack = fittedAnswerPack({ specHash: hash, role: q.role, question: q.text, docs: { projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'] } });
    if (!pack) return null;
    const out = (await deps.runAgent<'answer'>({ kind: 'answer', role: q.role, pack, cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx)) as StepOutcome<AnswerOutput>;
    return out.ok && out.value.answer ? { questionId: q.questionId, text: out.value.answer, by: q.role } : null;
  }));
  await journal.fact(RefineEvent.Evaluated, { cycle, checklist, questions: merged, discardedPatches, questionRouting, autoAnswerFloor: floor ?? null });
  for (const a of answers) if (a) await journal.fact(RefineEvent.QuestionAnswered, a);
}

/** The answer pack with its budget raised to the docs, so the question never drops out; null when the docs are past the cap. */
function fittedAnswerPack(input: Parameters<typeof answerPack>[0]): ReturnType<typeof answerPack> | null {
  try {
    return fitPackBudget(answerPack(input));
  } catch (err) {
    if (err instanceof PackTooLargeError) return null;
    throw err;
  }
}
