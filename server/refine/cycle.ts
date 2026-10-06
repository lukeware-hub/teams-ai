import type { DeriveOutput, OutputOf, RefineOutput, StepKind } from '../agents/outputs.js';
import type { z } from 'zod';
import { loadSecrets } from '../core/secrets.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Journal } from '../orchestrator/events.js';
import type { Decider } from '../decide/decider.js';
import { contradictedChunks, duplicatePairs, notReadyCriteria } from '../decide/decisions/gate1.js';
import type { AgentStepRequest } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import { mergeChecklist, type ChecklistItem } from './checklist.js';
import { derivePack, postProcessDerived } from './derive.js';
import { sha256 } from '../contracts/hash.js';
import { DOC_REL, draftHash, flowTemplate, readDerived, readDoc, stackTemplate, writeDerived, writeDoc, type DocFile, type Draft } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import type { JevValidationResult } from './jev-validation.js';
import { refinePack } from './packs.js';
import { applyPatch, checkPatch, patchId, unifiedDiff } from './patches.js';
import type { RefineState } from './state.js';

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
  validateDocs?: (docs: { project: string; briefing: string; stack: string; flow: string }) => Promise<JevValidationResult>;
  /** Spec 10A.5 decisions 2–4; absent (or the layer off) leaves the cycle as it was. */
  decider?: Pick<Decider, 'decide'>;
  /** Aborting kills the agent steps this cycle has running. */
  signal?: AbortSignal;
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
    jevValidation = await deps.validateDocs({ project: docs['project.md'], briefing: docs['brief.md'], stack: docs['stack.md'], flow: docs['flow.md'] }).catch(() => ({ available: false, decision: 'review' as const, consistent: null, confidence: null, model: null, checks: {}, stateTruncated: false }));
    const validation = jevValidation;
    await journal.fact(RefineEvent.DocsValidated, { cycle, backend: 'jev', ...validation });
    // Jev is advisory here: its findings are passed to Claude, PO, and SM for review.
  }

  const d = await deps.runAgent<'derive'>(
    {
      kind: 'derive',
      role: 'po',
      pack: derivePack({ specHash: hash, principles: deps.principles(), projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'], previous, specId: draft.specId, jevValidation }),
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
  const checked = postProcessDerived(d.value as DeriveOutput, previous?.spec ?? null, draft.specId);
  if (!checked.ok) {
    await fail(`derive: ${checked.issues.join('; ')}`);
    return;
  }
  await writeDerived(draft, checked.value);
  await journal.fact(RefineEvent.Derived, { cycle, ...checked.value });
  const dctx = { confidential: checked.value.project.confidential };
  const criteria = checked.value.spec.acceptanceCriteria;
  const notReady = deps.decider ? await notReadyCriteria(criteria, decider!, dctx) : null;

  const discardedPatches: Array<{ role: string; file: string; reason: string }> = [];
  if (deps.frontAgent) {
    const review = await deps.frontAgent({ kind: 'refine', role: 'front',
      pack: refinePack({ role: 'front', specHash: hash, principles: deps.principles(), specId: draft.specId,
        projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'],
        derived: checked.value, retrieval: [], history: journal.state.questions,
        rejected: journal.state.patches.filter((p) => p.status === 'rejected'), jevValidation }),
      cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx);
    if (!review.ok) { await fail(`front validation failed: ${review.failure}: ${review.errors.join('; ')}`); return; }
    let i = 0;
    for (const p of (review.value as z.infer<typeof RefineOutput>).docPatch) {
      const c = checkPatch(p, draft.specId, docs);
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
  const retrieval = deps.retrieval(checked.value.spec.objectives.join(' '));
  const step = (role: 'po' | 'sm') =>
    deps.runAgent<'refine'>(
      {
        kind: 'refine',
        role,
        pack: refinePack({
          role,
          specHash: hash,
          principles: deps.principles(),
          specId: draft.specId,
          projectMd: docs['project.md'],
          briefMd: docs['brief.md'],
          stackMd: docs['stack.md'],
          flowMd: docs['flow.md'],
          designMd: docs['design.md'],
          derived: checked.value,
          retrieval,
          history: state.questions,
          rejected: state.patches.filter((p) => p.status === 'rejected'),
          jevValidation,
          notReady,
        }),
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
    for (const i of await contradictedChunks(criteria, checked.value.spec.objectives, hits.map((h) => h.text), decider!, dctx)) {
      const h = hits[i]!;
      merged.push({ questionId: `po-c${cycle}-${counters.po++}`, role: 'po', text: `The new spec seems to contradict earlier project history (${h.title}${h.heading ? ` › ${h.heading}` : ''}): "${h.snippet}". Which one holds?`, blocking: true, relatedAcIds: [], cycle });
    }
  }

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
      const c = checkPatch(p, draft.specId, docs);
      if (c.ok && c.file === 'design.md') {
        discardedPatches.push({ role, file: p.file, reason: 'design.md is reviewable only by front' });
        continue;
      }
      if (!c.ok) {
        discardedPatches.push({ role, file: p.file, reason: c.reason });
        continue;
      }
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
  const missing = checked.value.spec.externalDependencies.flatMap((dep) => dep.secretNames).filter((n) => !(n in present));
  const secretsItem = checklist.find((i) => i.id === 'sm.dependencies-and-secrets')!;
  secretsItem.passed = missing.length === 0;
  secretsItem.detail = missing.length === 0 ? 'every listed secret is present' : `missing secrets: ${missing.join(', ')}`;
  const pendingBlocking = state.questions.filter((q) => q.status === 'pending' && q.blocking).length + merged.filter((q) => q.blocking).length;
  const openItem = checklist.find((i) => i.id === 'sm.no-open-questions')!;
  openItem.passed = pendingBlocking === 0;
  openItem.detail = pendingBlocking === 0 ? 'no blocking question open' : `${pendingBlocking} blocking question(s) open`;
  await journal.fact(RefineEvent.Evaluated, { cycle, checklist, questions: merged, discardedPatches });
}
