import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Architecture, repositoryContext, type RepoKind } from '../contracts/architecture.js';
import { loadEvents } from '../store/event-store.js';

/** The run statuses that stop a spec: its run needs the owner. */
export const BLOCKED_RUN: ReadonlySet<string> = new Set(['blocked', 'deadlocked', 'phase-failed']);

/** One event of a run's journal as the dashboard lists it. */
export interface HistoryEvent {
  at: string;
  type: string;
  runId: string;
  specId: string;
}

/** A repository's state, from the worst of its specs: blocked, running, waiting, refining, done; empty without specs. */
export type RepoStatus = 'blocked' | 'running' | 'waiting' | 'refining' | 'done' | 'empty';

/** A spec of the project as a repository page reads it: its status, its run, its place in the backlog, and its files. */
export interface RepoSpec {
  specId: string;
  /** The backlog key of the spec, which a question names in its item. */
  key: string | null;
  status: string;
  activeRunId: string | null;
  repository?: string;
  title: string | null;
  priority: string | null;
  dependsOn: string[];
  plan: boolean;
  tasks: number;
  /** The spec's run needs the owner: a run blocked, deadlocked or failed in its phase. */
  blocked: boolean;
}

export interface RepoSource {
  architecture: Architecture;
  specs: RepoSpec[];
  /** The owner's pending blocking questions of the project, each with the backlog item it is about. */
  questions?: Array<{ itemKey: string | null; text: string }>;
  /** The secrets the project's specs need that the vault does not hold, by name. */
  missingSecrets?: string[];
  /** The program items that stopped with a reason: a blocked, failed or partial spec. */
  programStops?: Array<{ specId: string; status: string; reason: string }>;
}

export interface RepoCard {
  name: string;
  kind: RepoKind | null;
  responsibility: string;
  status: RepoStatus;
  specs: number;
  plans: number;
  tasks: number;
  /** Tasks of the specs delivered on main: a task counts done when its spec is done. */
  tasksDone: number;
  /** Specs paused on a blocker (quota or authentication). */
  blockers: number;
}

export interface RepoDetail extends RepoCard {
  integrations: string[];
  rows: RepoSpec[];
  /** Why each stopped spec of the repository stopped, from the program's record. */
  reasons: Array<{ specId: string; status: string; reason: string }>;
  questions: Array<{ itemKey: string | null; text: string }>;
  missingSecrets: string[];
}

/** The status a repository shows: the worst state among its specs, retired ones aside. */
export function statusOf(rows: readonly RepoSpec[]): RepoStatus {
  const live = rows.filter((r) => r.status !== 'retired');
  if (live.length === 0) return 'empty';
  if (live.some((r) => r.blocked || r.status.startsWith('paused:'))) return 'blocked';
  if (live.some((r) => r.status === 'running' || r.activeRunId !== null)) return 'running';
  if (live.some((r) => r.status === 'awaiting-validation')) return 'waiting';
  if (live.some((r) => r.status === 'refining' || r.status === 'planned')) return 'refining';
  return 'done';
}

function cardOf(src: RepoSource, name: string): RepoCard | null {
  const ctx = repositoryContext(src.architecture, name);
  if (!ctx) return null;
  const rows = rowsOf(src, name);
  const delivered = rows.filter((r) => r.status === 'done');
  const keys = new Set(rows.map((r) => r.key).filter((k): k is string => k !== null));
  const questions = (src.questions ?? []).filter((q) => q.itemKey !== null && keys.has(q.itemKey)).length;
  return {
    name,
    kind: ctx.kind,
    responsibility: ctx.responsibility,
    status: statusOf(rows),
    specs: rows.length,
    plans: rows.filter((r) => r.plan).length,
    tasks: rows.reduce((sum, r) => sum + r.tasks, 0),
    tasksDone: delivered.reduce((sum, r) => sum + r.tasks, 0),
    blockers: rows.filter((r) => r.blocked || r.status.startsWith('paused:')).length + questions,
  };
}

/** One card per repository of the architecture, in the order the architecture names them. */
export function repositoryCards(src: RepoSource): RepoCard[] {
  return src.architecture.repositories.flatMap((repo) => cardOf(src, repo.name) ?? []);
}

/** The repository's specs, a spec the program stopped counting as blocked. */
function rowsOf(src: RepoSource, name: string): RepoSpec[] {
  const stopped = new Set((src.programStops ?? []).map((s) => s.specId));
  return src.specs.filter((s) => s.repository === name).map((s) => (stopped.has(s.specId) ? { ...s, blocked: true } : s));
}

/** The dashboard of one repository, or null when the architecture does not name it. */
export function repositoryDetail(src: RepoSource, name: string): RepoDetail | null {
  const card = cardOf(src, name);
  const ctx = repositoryContext(src.architecture, name);
  if (!card || !ctx) return null;
  return { ...card, integrations: ctx.integrations, rows: rowsOf(src, name), reasons: (src.programStops ?? []).filter((s) => src.specs.some((r) => r.repository === name && r.specId === s.specId)), questions: (src.questions ?? []).filter((q) => q.itemKey !== null && (src.specs.some((s) => s.repository === name && s.key === q.itemKey))), missingSecrets: src.missingSecrets ?? [] };
}

interface SpecIndexEntry {
  specId: string;
  key?: string;
  title?: string;
  priority?: string;
  dependsOn?: string[];
}

/** Reads a project's architecture, its spec index and each spec's files; null when the project has no architecture yet. */
export async function loadRepoSource(dir: string, specs: ReadonlyArray<Pick<RepoSpec, 'specId' | 'status' | 'activeRunId' | 'repository' | 'blocked'>>): Promise<RepoSource | null> {
  const architecture = await fs.readFile(path.join(dir, 'docs', 'architecture.json'), 'utf8').then((t) => Architecture.parse(JSON.parse(t)), () => null);
  if (!architecture) return null;
  const index = await fs.readFile(path.join(dir, 'docs', 'specs.json'), 'utf8').then((t) => (JSON.parse(t) as { specs?: SpecIndexEntry[] }).specs ?? [], () => [] as SpecIndexEntry[]);
  const byId = new Map(index.map((entry) => [entry.specId, entry]));
  const rows = await Promise.all(
    specs.map(async (spec): Promise<RepoSpec> => {
      const folder = path.join(dir, 'docs', 'specs', spec.specId);
      const entry = byId.get(spec.specId);
      const plan = await fs.access(path.join(folder, 'implementation-plan.md')).then(() => true, () => false);
      const tasks = await fs.readFile(path.join(folder, 'task.md'), 'utf8').then((t) => (t.match(/^## Task \d+:/gm) ?? []).length, () => 0);
      return { ...spec, key: entry?.key ?? null, title: entry?.title ?? null, priority: entry?.priority ?? null, dependsOn: entry?.dependsOn ?? [], plan, tasks };
    }),
  );
  return { architecture, specs: rows };
}

/** The last `limit` events of the runs given, oldest first; a run with no journal yet contributes nothing. */
export async function historyOf(runsDir: string, runs: ReadonlyArray<{ runId: string; specId: string }>, limit = 50): Promise<HistoryEvent[]> {
  const events = await Promise.all(
    runs.map(async (run) => (await loadEvents(path.join(runsDir, run.runId, 'events.ndjson')).catch(() => [])).map((e) => ({ at: e.at, type: e.type, runId: run.runId, specId: run.specId }))),
  );
  return events.flat().sort((a, b) => a.at.localeCompare(b.at)).slice(-limit);
}
