import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { canonicalJson } from '../contracts/hash.js';
import type { PlanTask } from '../contracts/plan.js';
import { parseRunId, runIdOf, stepId, type RunKind } from '../core/ids.js';
import { processAlive } from '../core/process.js';
import { RunEvent } from '../pipeline/run-state.js';
import { loadEvents, type StoredEvent } from '../store/event-store.js';
import { OrchEvent } from './events.js';

export interface Workspace {
  projectId: string;
  root: string;
  repo: string;
  worktrees: string;
  graph: string;
  knowledgeDb: string;
  secrets: string;
  runs: string;
}

export function expandHome(p: string, home: string = os.homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? path.posix.join(home, p.slice(2)) : p;
}

/** Spec §3: everything for a project under workspaces/<projectId>; runs are global, keyed by runId. */
export function workspacePaths(cfg: Config, projectId: string, home?: string): Workspace {
  const root = path.posix.join(expandHome(cfg.paths.workspaces, home), projectId);
  return {
    projectId,
    root,
    repo: path.posix.join(root, 'repo'),
    worktrees: path.posix.join(root, 'worktrees'),
    graph: path.posix.join(root, 'graph'),
    knowledgeDb: path.posix.join(root, 'knowledge.sqlite'),
    secrets: path.posix.join(root, 'secrets'),
    runs: expandHome(cfg.paths.runs, home),
  };
}

/** Where a service's code lives: the project's own repository for null, else `services/<service>` beside it. */
export function serviceWorkspace(ws: Workspace, service: string | null): Workspace {
  if (service === null) return ws;
  const root = path.posix.join(ws.root, 'services', service);
  return { ...ws, repo: path.posix.join(root, 'repo'), worktrees: path.posix.join(root, 'worktrees'), graph: path.posix.join(root, 'graph') };
}

const branchDir = (branch: string) => branch.replace(/\//g, '__');

export function worktreeDir(ws: Workspace, branch: string): string {
  return path.posix.join(ws.worktrees, branchDir(branch));
}

export function graphDir(ws: Workspace, branch: string | null): string {
  return branch === null ? path.posix.join(ws.graph, 'main') : path.posix.join(ws.graph, 'worktrees', branchDir(branch));
}

export function runDir(ws: Workspace, runId: string): string {
  return path.posix.join(ws.runs, runId);
}

export function eventsFile(ws: Workspace, runId: string): string {
  return path.posix.join(runDir(ws, runId), 'events.ndjson');
}

export function stateFile(ws: Workspace, runId: string): string {
  return path.posix.join(runDir(ws, runId), 'state.json');
}

/** Where a task's agent session transcript is kept between its attempts (runner/session-store.ts). */
export function sessionDir(ws: Workspace, runId: string, taskId: string): string {
  return path.posix.join(runDir(ws, runId), 'sessions', taskId.replace(/[^\w.-]/g, '_'));
}

export function stepDir(ws: Workspace, runId: string, seq: number): string {
  return path.posix.join(runDir(ws, runId), 'steps', stepId(seq));
}

/**
 * The runs of one spec and kind among the run directory `names`, with their numbers: this project's readable ids plus
 * the legacy ones, which never named a project (callers that care check the project in their RUN_STARTED).
 */
function specRuns(names: readonly string[], projectId: string, specId: string, kind: RunKind = 'run'): Array<{ name: string; n: number }> {
  return names.flatMap((name) => {
    const r = parseRunId(name);
    return r && r.specId === specId && r.kind === kind && (r.projectId === null || r.projectId === projectId) ? [{ name, n: r.n }] : [];
  });
}

/**
 * `runIdOf(project, spec, kind, n)`, n = 1 + the highest existing run number for that spec and kind (legacy ids
 * included, so numbering carries on). The run directory is created here, without `recursive`, so callers racing for
 * one number cannot both get it: the loser sees EEXIST and takes the next.
 */
export async function nextRunId(ws: Pick<Workspace, 'runs' | 'projectId'>, specId: string, kind: RunKind = 'run'): Promise<string> {
  await fs.mkdir(ws.runs, { recursive: true });
  const highest = specRuns(await fs.readdir(ws.runs), ws.projectId, specId, kind).reduce((acc, r) => Math.max(acc, r.n), 0);
  for (let n = highest + 1; ; n++) {
    const id = runIdOf(ws.projectId, specId, kind, n);
    try {
      await fs.mkdir(path.posix.join(ws.runs, id));
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** The spec a run belongs to, from the RUN_STARTED it journals first; null when the run never started. */
export async function specForRun(ws: Workspace, runId: string): Promise<string | null> {
  const started = (await loadEvents(eventsFile(ws, runId)).catch(() => [])).find((e) => e.type === OrchEvent.RunStarted);
  return typeof started?.data.specId === 'string' ? started.data.specId : null;
}

/**
 * Whether the run was the spec that scaffolds the project, as it journaled it when it started; null for a run that never
 * started or predates the field. Asking main again on a resume would answer "no" once the run's own scaffold has merged.
 */
export async function firstSpecForRun(ws: Workspace, runId: string): Promise<boolean | null> {
  const started = (await loadEvents(eventsFile(ws, runId)).catch(() => [])).find((e) => e.type === OrchEvent.RunStarted);
  return typeof started?.data.firstSpec === 'boolean' ? started.data.firstSpec : null;
}

/**
 * Whether any earlier run of this spec in this project recorded `firstSpec`; null when none exists or none recorded
 * it. A fresh run (a retry, not a `--run` resume) has no answer of its own to carry forward, and asking main directly
 * would answer false once the spec's own earlier run already merged its scaffold onto it.
 */
export async function firstSpecForSpec(ws: Workspace, specId: string, runId: string): Promise<boolean | null> {
  const mine = specRuns([runId], ws.projectId, specId)[0]?.n ?? Infinity;
  let answer: boolean | null = null;
  for (const { name, n } of specRuns(await fs.readdir(ws.runs).catch(() => [] as string[]), ws.projectId, specId)) {
    if (n >= mine) continue;
    const events = await loadEvents(eventsFile(ws, name)).catch(() => []);
    const started = events.find((e) => e.type === OrchEvent.RunStarted);
    if (started === undefined || started.data.projectId !== ws.projectId) continue;
    if (typeof started.data.firstSpec === 'boolean') {
      if (started.data.firstSpec) return true;
      answer = false;
    }
  }
  return answer;
}

/** Is the process named by an event-log lock (`<pid>@<host>`, written by store/event-store.ts) running on this host? */
async function lockHeld(lockFile: string): Promise<boolean> {
  const owner = await fs.readFile(lockFile, 'utf8').then((text) => text.trim().split('@'), () => null);
  if (owner === null) return false;
  // A lock from another host is a previous container life, which the store reclaims too.
  if (owner[1] !== undefined && owner[1] !== os.hostname()) return false;
  // Only a missing process (or a zombie) frees the lock; an unreadable owner counts as held, the safe side for a guard.
  return processAlive(Number.parseInt(owner[0] ?? '', 10));
}

/**
 * R11.4 retry: the ids of `tasks` an earlier run of this spec in this project delivered itself, through a merged pull
 * request or as work already on main, with the same definition; a new version that changed a task does it again.
 */
export async function mergedByPriorRuns(ws: Workspace, specId: string, runId: string, tasks: readonly PlanTask[]): Promise<Set<string>> {
  const delivered = new Set<string>();
  for (const events of await priorRunEvents(ws, specId, runId)) {
    const planned = new Map(events.filter((e) => e.type === RunEvent.TaskPlanned).map((e) => [(e.data.task as PlanTask).id, e.data.task]));
    // An adopted task is no evidence: only a merge or the work found on main proves this run delivered it.
    const done = new Set(events.filter((e) => e.type === OrchEvent.PrMerged || e.type === OrchEvent.AlreadyOnMain).map((e) => e.data.taskId as string));
    // A replaced task is delivered once every task that replaced it merged; the plan still lists the original id.
    for (const e of events) {
      if (e.type === RunEvent.TaskReplanned && (e.data.replacements as { id: string }[]).every((r) => done.has(r.id))) done.add(e.data.taskId as string);
    }
    // A T900-fix-* task answers one verification attempt's own findings, so a retry never carries it as done.
    for (const id of done) if (!id.startsWith('T900-fix-') && planned.has(id)) delivered.add(canonicalJson(planned.get(id)));
  }
  return new Set(tasks.filter((t) => delivered.has(canonicalJson(t))).map((t) => t.id));
}

/** The journals of every earlier run of this spec in this project, oldest first. */
export async function priorRunEvents(ws: Workspace, specId: string, runId: string): Promise<StoredEvent[][]> {
  const mine = specRuns([runId], ws.projectId, specId)[0]?.n ?? Infinity;
  const out: StoredEvent[][] = [];
  for (const { name, n } of specRuns(await fs.readdir(ws.runs).catch(() => [] as string[]), ws.projectId, specId).sort((a, b) => a.n - b.n)) {
    if (n >= mine) continue;
    const events = await loadEvents(eventsFile(ws, name)).catch(() => []);
    const started = events.find((e) => e.type === OrchEvent.RunStarted);
    if (started !== undefined && started.data.projectId !== ws.projectId) continue; // run numbers are shared across projects with the same spec id
    out.push(events);
  }
  return out;
}

/**
 * An older run of this spec, in this project, that is still live; null when there is none. Task branches and worktrees
 * are named after the spec alone, so the older run keeps them and a newer one must not reset them. A run is live while
 * its journal holds the lock on its event log: the lock goes with `close()` and with a dead process, so no second lock
 * file is needed.
 */
export async function olderLiveRun(ws: Workspace, specId: string, runId: string): Promise<string | null> {
  const mine = specRuns([runId], ws.projectId, specId)[0]?.n ?? Infinity;
  for (const { name } of specRuns(await fs.readdir(ws.runs).catch(() => [] as string[]), ws.projectId, specId).filter((r) => r.n < mine)) {
    if (!(await lockHeld(`${eventsFile(ws, name)}.lock`))) continue;
    // Run numbers are shared by every project that has a spec of this id; only a run of this project owns our worktrees.
    const started = (await loadEvents(eventsFile(ws, name)).catch(() => [])).find((e) => e.type === OrchEvent.RunStarted);
    if (started === undefined || started.data.projectId === ws.projectId) return name;
  }
  return null;
}
