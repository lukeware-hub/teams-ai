import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type { CoverageOutput as CoverageOutputSchema, OutputOf, TechSpecOutput as TechSpecOutputSchema } from '../../agents/outputs.js';
import type { StepOutcome } from '../../runner/step.js';

type TechSpecOutput = z.infer<typeof TechSpecOutputSchema>;
type CoverageOutput = z.infer<typeof CoverageOutputSchema>;
import { OrchEvent } from '../events.js';
import { coveragePack, techSpecPack } from '../steps.js';
import { commitAndMergeDocs, docsWorktree, readDocs, readInWorktree, trackedAndUntracked, type PhaseDeps, type PhaseResult } from './shared.js';

/** Spec (orchestrator) §4.2. */
export async function runPhase1(deps: PhaseDeps): Promise<PhaseResult & { techSpecText?: string }> {
  const existing = await readDocs(deps.ws.repo, deps.spec.specId, deps.exec);
  if (existing.techSpecText !== null) return { ok: true, techSpecText: existing.techSpecText };
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 1 });
  const branch = `docs/${deps.spec.specId}`;
  const worktree = await docsWorktree(deps, branch);
  const max = deps.maxPhaseAttempts ?? 3;
  let feedback: string | null = null;
  let techSpecText = '';
  let lastUncovered: string[] = [];
  for (let attempt = 1; attempt <= max; attempt++) {
    const files = await trackedAndUntracked(worktree, deps.exec);
    const wrote: StepOutcome<OutputOf<'tech-spec'>> = await deps.runAgent<'tech-spec'>({
      kind: 'tech-spec',
      role: 'dev',
      pack: techSpecPack(deps.packBase(), { feedback }),
      cwd: worktree,
      phase: 'phase1',
      taskId: null,
      attempt,
      refContext: { acIds: new Set(deps.spec.acceptanceCriteria.map((c) => c.id)), taskIds: new Set(), files: await trackedAndUntracked(worktree, deps.exec), tests: new Set(), adrIds: new Set() },
      refs: ((v: TechSpecOutput) => ({ files: [v.techSpecPath, ...v.adrs.map((a) => a.path)] })) as never,
    });
    void files;
    if (!wrote.ok) {
      feedback = `Previous attempt failed (${wrote.failure}):\n${wrote.errors.join('\n')}`;
      continue;
    }
    const spec = wrote.value as TechSpecOutput;
    await deps.journal.fact(OrchEvent.TechSpecWritten, { path: spec.techSpecPath, adrs: spec.adrs, stack: spec.stack, attempt });
    techSpecText = await readInWorktree(worktree, spec.techSpecPath);
    const checked: StepOutcome<OutputOf<'coverage'>> = await deps.runAgent<'coverage'>({ kind: 'coverage', role: 'po', pack: coveragePack(deps.packBase(), { techSpecText }), cwd: worktree, phase: 'phase1', taskId: null, attempt });
    if (!checked.ok) {
      feedback = `Coverage check failed (${checked.failure}):\n${checked.errors.join('\n')}`;
      continue;
    }
    const cov = checked.value as CoverageOutput;
    const covered = new Set(cov.coverage.filter((c) => c.covered).map((c) => c.acId));
    lastUncovered = deps.spec.acceptanceCriteria.map((c) => c.id).filter((id) => !covered.has(id));
    await deps.journal.fact(OrchEvent.CoverageChecked, { attempt, uncovered: lastUncovered });
    if (lastUncovered.length === 0) {
      const merged = await commitAndMergeDocs(deps, 1, branch, worktree, `docs(${deps.spec.specId}): technical spec`);
      return merged.ok ? { ok: true, techSpecText } : merged;
    }
    feedback = `The PO found these acceptance criteria uncovered by the tech spec; cover each with its own section:\n${lastUncovered.map((id) => `- ${id}: ${cov.coverage.find((c) => c.acId === id)?.note ?? ''}`).join('\n')}`;
  }
  const reason = `Phase 1 exhausted ${max} attempts; uncovered: ${lastUncovered.join(', ') || 'n/a'}`;
  await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 1, reason });
  await fs.rm(path.join(worktree), { recursive: true, force: true }).catch(() => undefined);
  return { ok: false, reason };
}
