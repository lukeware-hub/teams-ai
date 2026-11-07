import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FIVE_DOC_PATHS } from '../../docs/layout.js';
import type { DocsTreeOutput } from '../../agents/outputs.js';
import { kindOfService, kindsOfMonolith, type AppKind } from '../../docs/tree.js';
import type { ServiceView } from '../../contracts/plan.js';
import type { StepOutcome } from '../../runner/step.js';
import { validateDocsTree } from '../../validators/docs-tree.js';
import { OrchEvent } from '../events.js';
import { docsPack } from '../steps.js';
import { commitAndMergeDocs, freshDocsWorktree, pauseForFailure, PAUSED_AUTH, type PhaseDeps, type PhaseResult } from './shared.js';

/** Every file under docs/ of a checkout, keyed by its repository path. */
async function docsFiles(worktree: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.set(path.relative(worktree, full).split(path.sep).join('/'), await fs.readFile(full, 'utf8'));
    }
  };
  await walk(path.join(worktree, 'docs'));
  return files;
}

/** The kinds of application a repository holds: its service's kind, or what a monolith's plan deploys and builds. */
const kindsOf = (view: ServiceView): AppKind[] =>
  view.service ? [kindOfService(view.service)] : kindsOfMonolith(view.plan.deploy.kind ? [view.plan.deploy.kind] : [], view.plan.tasks.some((t) => t.owner === 'front'));

/**
 * Phase 8: the docs of the delivered code, written in the numbered tree of the repository and merged as one docs pull
 * request. It runs after verification, so the code it documents is the code on main; a rejected tree blocks the run.
 */
export async function runDocsPhase(deps: PhaseDeps, view: ServiceView): Promise<PhaseResult> {
  const branch = `docs/${deps.spec.specId}${deps.service ? `-${deps.service}` : ''}-docs`;
  if ([...deps.journal.events].some((e) => e.type === OrchEvent.DocsMerged && e.data.branch === branch)) return { ok: true };
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 8 });
  const wt = await freshDocsWorktree(deps, branch, 8);
  const before = await docsFiles(wt);
  const kinds = kindsOf(view);
  const delivered = view.plan.tasks.filter((t) => deps.journal.state.tasks.get(t.id)?.state === 'merged');
  const readmeSections = view.plan.delivery?.readmeSections;
  let docsErrors: string[] = [];
  let written = false;
  for (let attempt = 1; attempt <= 2 && !written; attempt++) {
    const out = (await deps.runAgent<'docs'>({ kind: 'docs', role: 'docs', pack: docsPack(deps.packBase(), { tasks: delivered.map((t) => `- ${t.id}: ${t.title}`), kinds, features: deps.spec.features, readmeSections, docsErrors }), cwd: wt, phase: 'phase8', taskId: null, attempt })) as StepOutcome<DocsTreeOutput>;
    if (!out.ok) {
      if (out.failure === 'quota' || out.failure === 'auth') {
        if (await pauseForFailure(deps, out.failure)) return { ok: false, reason: PAUSED_AUTH };
      } else docsErrors = out.errors ?? ['docs step failed'];
      continue;
    }
    const files = await docsFiles(wt);
    const changedMain = FIVE_DOC_PATHS.filter((p) => files.get(p) !== before.get(p)).map((p) => `${p} is a main document and must not change`);
    docsErrors = [...changedMain, ...validateDocsTree({ files, current: before, kinds, delivered: delivered.map((t) => t.id), covered: out.value.files.flatMap((f) => f.covers), features: deps.spec.features, readmeSections })];
    written = docsErrors.length === 0;
  }
  if (!written) {
    const reason = `Phase 8 blocked: documentation rejected: ${docsErrors.join('; ')}`;
    await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 8, reason });
    return { ok: false, reason };
  }
  return commitAndMergeDocs(deps, 8, branch, wt, `docs(${deps.spec.specId}): documentation`);
}
