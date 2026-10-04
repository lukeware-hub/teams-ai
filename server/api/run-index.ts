import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { Project } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';
import { expandHome } from '../orchestrator/workspace.js';
import { loadEvents } from '../store/event-store.js';

/** Run, spec and step ids become path segments: no leading dot, so neither `.` nor `..` matches. */
export const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export type RunListStatus = 'running' | 'paused:quota' | 'paused:auth' | 'draining' | 'complete' | 'blocked' | 'deadlocked' | 'drained' | 'phase-failed' | 'awaiting-validation' | 'verification-failed' | 'deploy-failed' | 'done' | 'interrupted' | 'unknown';
const ACTIVE: ReadonlySet<string> = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);
/** A spec with an interrupted run is resumed, not restarted: the UI offers Resume instead of Start. */
export const CLAIMS_SPEC: ReadonlySet<string> = new Set([...ACTIVE, 'interrupted']);

export interface RunRow {
  runId: string;
  specId: string;
  projectId: string;
  status: RunListStatus;
  at: string | null;
  tokens: number;
  cost: number;
  stoppable: boolean;
}
export interface SpecRow {
  specId: string;
  status: string;
  activeRunId: string | null;
}
export interface ProjectRow {
  projectId: string;
  dir: string;
  specs: SpecRow[];
}
export interface IndexDeps {
  cfg: Config;
  home?: string;
  isAlive: (pid: number) => boolean;
}

export function runsDir(deps: IndexDeps): string {
  return expandHome(deps.cfg.paths.runs, deps.home);
}

export async function readProject(dir: string): Promise<{ project: Project; specs: Spec[] }> {
  const project = Project.parse(JSON.parse(await fs.readFile(path.join(dir, 'docs', 'project.json'), 'utf8')));
  const specsDir = path.join(dir, 'docs', 'specs');
  const ids = await fs.readdir(specsDir).catch(() => [] as string[]);
  const specs: Spec[] = [];
  for (const id of ids.sort()) {
    const text = await fs.readFile(path.join(specsDir, id, 'spec.json'), 'utf8').catch(() => null);
    if (text !== null) specs.push(Spec.parse(JSON.parse(text)));
  }
  return { project, specs };
}

const pidFile = (runs: string, runId: string) => path.join(runs, runId, 'pid');
export async function readPid(runs: string, runId: string): Promise<number | null> {
  const t = await fs.readFile(pidFile(runs, runId), 'utf8').catch(() => null);
  const n = t === null ? NaN : Number(t.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
export async function writePid(runs: string, runId: string, pid: number): Promise<void> {
  await fs.rm(`${pidFile(runs, runId)}.gone`, { force: true });
  await fs.writeFile(pidFile(runs, runId), String(pid));
}
/** The stale pid file becomes `pid.gone`: the run keeps showing interrupted until it is resumed or finished. */
export async function clearPid(runs: string, runId: string): Promise<void> {
  await fs.rename(pidFile(runs, runId), `${pidFile(runs, runId)}.gone`).catch(() => undefined);
}
async function wasInterrupted(runs: string, runId: string): Promise<boolean> {
  return fs.access(`${pidFile(runs, runId)}.gone`).then(
    () => true,
    () => false,
  );
}

interface StateFile {
  at?: string;
  status?: string;
  tokens?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

async function runRow(deps: IndexDeps, runId: string): Promise<RunRow | null> {
  const runs = runsDir(deps);
  const events = await loadEvents(path.join(runs, runId, 'events.ndjson')).catch(() => []);
  const startedAt = events.find((e) => e.type === 'RUN_STARTED');
  const specId = String(startedAt?.data.specId ?? runId.replace(/-r\d+$/, ''));
  const projectId = startedAt ? String(startedAt.data.projectId) : null;
  const finished = [...events].reverse().find((e) => e.type === 'RUN_FINISHED');
  const state: StateFile | null = await fs
    .readFile(path.join(runs, runId, 'state.json'), 'utf8')
    .then((t) => JSON.parse(t) as StateFile)
    .catch(() => null);
  const pid = await readPid(runs, runId);
  const alive = pid !== null && deps.isAlive(pid);
  if (pid !== null && !alive) await clearPid(runs, runId);
  const interrupted = (pid !== null && !alive) || (pid === null && (await wasInterrupted(runs, runId)));
  let status: RunListStatus;
  if (finished) status = String(finished.data.result) as RunListStatus;
  else if (!state?.status) status = 'unknown';
  else if (interrupted) status = 'interrupted';
  else status = state.status as RunListStatus;
  const tokens = (state?.tokens?.inputTokens ?? 0) + (state?.tokens?.outputTokens ?? 0);
  return { runId, specId, projectId: projectId ?? '', status, at: state?.at ?? finished?.at ?? null, tokens, cost: state?.tokens?.costUsd ?? 0, stoppable: alive && ACTIVE.has(status) };
}

async function specIdsOf(deps: IndexDeps, projectId: string): Promise<Set<string>> {
  for (const { dir } of deps.cfg.projects) {
    const read = await readProject(dir).catch(() => null);
    if (read?.project.projectId === projectId) return new Set(read.specs.map((s) => s.specId));
  }
  return new Set();
}

export async function listRuns(deps: IndexDeps, projectId: string): Promise<RunRow[]> {
  const runs = runsDir(deps);
  const names = (await fs.readdir(runs).catch(() => [] as string[])).filter((n) => SAFE_ID.test(n));
  // A run that crashed before RUN_STARTED has no project in its journal; its id still names the spec.
  const specIds = await specIdsOf(deps, projectId);
  const rows: RunRow[] = [];
  for (const runId of names) {
    const row = await runRow(deps, runId);
    if (!row) continue;
    if (row.projectId === projectId || (row.projectId === '' && specIds.has(row.specId))) rows.push({ ...row, projectId });
  }
  // newest first: runs without a state snapshot (just started) on top, then by state timestamp, then by the numeric suffix
  const suffix = (r: RunRow) => Number(/-r(\d+)$/.exec(r.runId)?.[1] ?? 0);
  return rows.sort((a, b) => {
    if ((a.at === null) !== (b.at === null)) return a.at === null ? -1 : 1;
    return (b.at ?? '').localeCompare(a.at ?? '') || suffix(b) - suffix(a);
  });
}

export async function listProjects(deps: IndexDeps): Promise<ProjectRow[]> {
  const out: ProjectRow[] = [];
  for (const { dir } of deps.cfg.projects) {
    const read = await readProject(dir).catch(() => null);
    if (!read) continue;
    const runs = await listRuns(deps, read.project.projectId);
    out.push({
      projectId: read.project.projectId,
      dir,
      specs: read.specs.map((s) => ({ specId: s.specId, status: s.status, activeRunId: runs.find((r) => r.specId === s.specId && CLAIMS_SPEC.has(r.status))?.runId ?? null })),
    });
  }
  return out;
}
