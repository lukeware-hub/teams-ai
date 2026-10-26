import { promises as fs } from 'node:fs';
import { assignDeployPort, portKey } from '../../deploy/port-registry.js';
import path from 'node:path';
import type { OutputOf } from '../../agents/outputs.js';
import { parseAnyPlan, type AnyPlan, type Plan, type ServicesPlan } from '../../contracts/plan.js';
import type { StepOutcome } from '../../runner/step.js';
import { canonicalJson } from '../../contracts/hash.js';
import { RunEvent } from '../../pipeline/run-state.js';
import { validatePlan, validateServicesPlan } from '../../validators/plan.js';
import { holdsOnlyDocs } from '../first-spec.js';
import { serviceWorkspace } from '../workspace.js';
import { git } from '../../git/git.js';
import { rankPlans } from '../../decide/decisions/plan-rank.js';
import { Intent, OrchEvent } from '../events.js';
import { planPack } from '../steps.js';
import { PAUSED_AUTH, commitAndMergeDocs, docsCommitKey, docsWorktree, pauseForFailure, planIsStale, preplanDeviation, readDocs, specDir, type PhaseDeps, type PhaseResult } from './shared.js';

/** Spec (orchestrator) §4.3. */
export async function runPhase2(deps: PhaseDeps, techSpecText: string): Promise<PhaseResult & { plan?: AnyPlan }> {
  const existing = await readDocs(deps.ws.repo, deps.spec.specId, deps.exec);
  if (existing.plan !== null && !planIsStale(existing.plan, deps.specHash)) {
    await journalTasks(deps, existing.plan);
    return { ok: true, plan: existing.plan };
  }
  const preplan = existing.preplan;
  const branch = `docs/${deps.spec.specId}-plan`;
  if (deps.journal.isConfirmed(Intent.DocsCommit, docsCommitKey(deps, 2))) {
    const worktree = await docsWorktree(deps, branch, { keepCommits: true });
    // Read before the merge: the docs merge removes the worktree afterwards.
    const plan = parseAnyPlan(JSON.parse(await fs.readFile(path.join(worktree, `${specDir(deps.spec.specId)}/plan.json`), 'utf8')));
    const merged = await commitAndMergeDocs(deps, 2, branch, worktree, `docs(${deps.spec.specId}): plan`);
    if (!merged.ok) return merged;
    await journalTasks(deps, plan);
    return { ok: true, plan };
  }
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 2 });
  const worktree = await docsWorktree(deps, branch);
  const max = deps.maxPhaseAttempts ?? 3;
  const names = deps.project.services ?? [];
  const services = names.length > 0 ? await servicesContext(deps, names) : null;
  const speckit = await speckitFiles(worktree, deps.packBase().speckitFeature);
  const require = { requireDelivery: deps.requireDelivery, requireSecurityTooling: deps.requireSecurityTooling, requireE2e: deps.requireE2e, generatedSecretNames: deps.generatedSecretNames, requireCoverage: deps.requireCoverage, requireFrozenScope: deps.requireFrozenScope, speckitTasks: speckit ? speckitTaskIds(speckit.tasks) : undefined };
  const single = services
    ? null
    : { repoFiles: new Set((await git(worktree, ['ls-files'], deps.exec)).split('\n').filter((f) => f !== '')), ports: deps.workspacesRoot ? await assignDeployPort(deps.workspacesRoot, deps.ws.projectId, deps.exec) : { port: null, taken: [] as number[] } };
  const check = (p: Plan) => validatePlan(p, deps.spec, { firstSpec: deps.firstSpec, ...require, repoFiles: single!.repoFiles, takenPorts: single!.ports.taken });
  let feedback: string | null = null;
  // Each attempt writes the whole plan again: every earlier rejection stays in the feedback, or a later plan brings it back.
  const rejected: string[] = [];
  for (let attempt = 1; attempt <= max; attempt++) {
    const out: StepOutcome<OutputOf<'plan'>> | StepOutcome<OutputOf<'services-plan'>> = services
      ? await deps.runAgent<'services-plan'>({
          kind: 'services-plan',
          role: 'sm',
          pack: planPack(deps.packBase(), { techSpecText, preplan, godNodes: [], feedback, ...require, services: { names, newServices: services.newServices, ports: services.ports, platform: deps.project.platform ?? [], files: Object.fromEntries(Object.entries(services.repoFiles).map(([s, files]) => [s, [...files].sort()])) }, speckit }),
          cwd: worktree,
          phase: 'phase2',
          taskId: null,
          attempt,
          semantic: [((p: ServicesPlan) => validateServicesPlan(p, deps.spec, { services: names, newServices: services.newServices, repoFiles: services.repoFiles, takenPorts: services.takenPorts, ports: services.ports, ...require })) as never],
        })
      : await deps.runAgent<'plan'>({
          kind: 'plan',
          role: 'sm',
          pack: planPack(deps.packBase(), { techSpecText, preplan, godNodes: await deps.godNodes(), feedback, firstSpec: deps.firstSpec, ...require, deployPort: single!.ports.port, speckit }),
          cwd: worktree,
          phase: 'phase2',
          taskId: null,
          attempt,
          semantic: [check as never],
        });
    if (!out.ok) {
      if (out.failure === 'quota' || out.failure === 'auth') {
        if (await pauseForFailure(deps, out.failure)) return { ok: false, reason: PAUSED_AUTH };
        attempt -= 1;
        continue;
      }
      rejected.push(...out.errors.filter((e) => !rejected.includes(e)));
      feedback = `Previous plans were rejected (${out.failure}); the next plan must avoid every one of these errors, also those an earlier attempt already fixed:\n${rejected.join('\n')}`;
      continue;
    }
    // A services plan has no alternatives: the ranking reads one stack.
    let plan: AnyPlan = out.value as ServicesPlan;
    if (!services) {
      const { alternatives = [], ...primary } = out.value as Plan & { alternatives?: Plan[] };
      const valid = alternatives.filter((p) => p.specHash === deps.specHash && check(p).length === 0);
      const candidates: Plan[] = [primary, ...valid];
      plan = primary;
      if (candidates.length > 1) {
        const ranking = deps.decider ? await rankPlans(deps.spec, candidates, deps.decider, { confidential: deps.project.confidential }) : { index: 0, source: 'default' as const };
        plan = candidates[ranking.index]!;
        await deps.journal.fact(OrchEvent.PlanChosen, { index: ranking.index, candidates: candidates.length, source: ranking.source });
      }
    }
    const rel = `${specDir(deps.spec.specId)}/plan.json`;
    await fs.mkdir(path.dirname(path.join(worktree, rel)), { recursive: true });
    await fs.writeFile(path.join(worktree, rel), `${JSON.stringify(JSON.parse(canonicalJson(plan)), null, 2)}\n`);
    const merged = await commitAndMergeDocs(deps, 2, branch, worktree, `docs(${deps.spec.specId}): plan`);
    if (!merged.ok) return merged;
    if (preplan) {
      const missingCriteria = preplanDeviation(preplan, plan);
      if (missingCriteria.length > 0) await deps.journal.fact(OrchEvent.PreplanDeviation, { missingCriteria });
    }
    await journalTasks(deps, plan);
    return { ok: true, plan };
  }
  const reason = `Phase 2 exhausted ${max} attempts; last feedback: ${feedback ?? 'none'}`;
  await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 2, reason });
  return { ok: false, reason };
}

/** R12.6: what Phase 2 knows of each service: its files, whether its main holds code yet, and its host port. */
async function servicesContext(deps: PhaseDeps, names: readonly string[]) {
  const repoFiles: Record<string, Set<string>> = {};
  const newServices = new Set<string>();
  const ports: Record<string, number | null> = {};
  let takenPorts: number[] | null = null;
  for (const s of names) {
    const repo = serviceWorkspace(deps.ws, s).repo;
    if (await holdsOnlyDocs(repo, deps.exec)) newServices.add(s);
    repoFiles[s] = new Set((await git(repo, ['ls-tree', '-r', '--name-only', 'origin/main'], deps.exec).catch(() => '')).split('\n').filter((f) => f !== ''));
    const assigned = deps.workspacesRoot ? await assignDeployPort(deps.workspacesRoot, portKey(deps.ws.projectId, s), deps.exec) : { port: null, taken: [] };
    ports[s] = assigned.port;
    // Each list counts the sibling services' ports as taken; only a port every list holds belongs to someone else.
    takenPorts = takenPorts === null ? assigned.taken : takenPorts.filter((p) => assigned.taken.includes(p));
  }
  return { repoFiles, newServices, ports, takenPorts: takenPorts ?? [] };
}

/** The Spec Kit plan.md and tasks.md of this spec on main, when its refinement prepared a feature folder. */
async function speckitFiles(worktree: string, feature: string | undefined) {
  if (!feature) return undefined;
  const read = (file: string) => fs.readFile(path.join(worktree, feature, file), 'utf8');
  return { feature, plan: await read('plan.md'), tasks: await read('tasks.md') };
}

/** The task ids of a Spec Kit tasks.md, each at the start of a checklist line such as `- [ ] T001 [P] Create the model`. */
const speckitTaskIds = (tasks: string): string[] => [...new Set([...tasks.matchAll(/^\s*- \[[ xX]\] (T\d+)\b/gm)].map((m) => m[1]!))];

async function journalTasks(deps: PhaseDeps, plan: AnyPlan): Promise<void> {
  for (const task of plan.tasks) {
    if (!deps.journal.state.tasks.has(task.id)) await deps.journal.fact(RunEvent.TaskPlanned, { task });
  }
}
