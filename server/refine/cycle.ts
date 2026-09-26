import type { DeriveOutput, OutputOf, RefineOutput, StepKind } from '../agents/outputs.js';
import type { z } from 'zod';
import { loadSecrets } from '../core/secrets.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Journal } from '../orchestrator/events.js';
import type { AgentStepRequest } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import { mergeChecklist, type ChecklistItem } from './checklist.js';
import { derivePack, postProcessDerived } from './derive.js';
import { draftHash, readDerived, readDoc, writeDerived, type DocFile, type Draft } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import type { JevValidationResult } from './jev-validation.js';
import { refinePack } from './packs.js';
import { applyPatch, checkPatch, patchId, unifiedDiff } from './patches.js';
import type { RefineState } from './state.js';

export type RunAgent = <K extends StepKind>(
  req: AgentStepRequest<K>,
  ctx: { journal: Pick<Journal, 'allocStepSeq' | 'fact'>; stepDir: (seq: number) => string; specHash: string },
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
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Spec (refinement) §3.2: derive → PO ∥ SM → merge questions → check patches → checklist with orchestrator overrides. */
export async function runCycle(deps: CycleDeps, cycle: number): Promise<void> {
  const { draft, journal } = deps;
  const hash = await draftHash(draft);
  await journal.fact(RefineEvent.CycleStarted, { cycle, draftHash: hash });
  const ctx = { journal, stepDir: draft.steps, specHash: hash };
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
    if (validation.decision === 'blocked') {
      await fail(`Jev bloqueou a derivação: ${Object.entries(validation.checks).filter(([, value]) => value < 0.5).map(([id]) => id).join(', ') || 'inconsistência grave'}`);
      return;
    }
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

  if (deps.frontAgent) {
    const review = await deps.frontAgent({ kind: 'refine', role: 'front',
      pack: refinePack({ role: 'po', specHash: hash, principles: deps.principles(), specId: draft.specId,
        projectMd: docs['project.md'], briefMd: docs['brief.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'],
        derived: checked.value, retrieval: [], history: journal.state.questions,
        rejected: journal.state.patches.filter((p) => p.status === 'rejected'), jevValidation }),
      cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx);
    if (!review.ok) { await fail(`front validation failed: ${review.failure}: ${review.errors.join('; ')}`); return; }
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

  const discardedPatches: Array<{ role: string; file: string; reason: string }> = [];
  for (const [role, out] of [['po', po.value], ['sm', sm.value]] as const) {
    let i = 0;
    for (const p of out.docPatch) {
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
