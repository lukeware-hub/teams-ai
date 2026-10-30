import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { Project } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';
import { parseRunId, type RunKind } from '../core/ids.js';
import { expandHome } from '../orchestrator/workspace.js';
import { loadEvents } from '../store/event-store.js';
import { probeProcess } from './process-identity.js';

/** Run, spec and step ids become path segments: no leading dot, so neither `.` nor `..` matches. */
export const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export type RunListStatus = 'running' | 'paused:quota' | 'paused:auth' | 'draining' | 'complete' | 'blocked' | 'deadlocked' | 'drained' | 'phase-failed' | 'awaiting-validation' | 'verification-failed' | 'deploy-failed' | 'done' | 'interrupted' | 'launch-failed' | 'unknown';
const ACTIVE: ReadonlySet<string> = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);
/** A spec with an interrupted run is resumed, not restarted: the UI offers Resume instead of Start. */
export const CLAIMS_SPEC: ReadonlySet<string> = new Set([...ACTIVE, 'interrupted']);
/** A locked run belongs to a concluded spec: read-only, so it never holds the spec. */
/** A run the user stopped no longer holds its spec, so a new run may start; only the latest run of a spec resumes. */
export const claimsSpec = (r: RunRow): boolean => !r.locked && !r.stopped && CLAIMS_SPEC.has(r.status);

export interface RunRow {
  runId: string;
  specId: string;
  projectId: string;
  status: RunListStatus;
  at: string | null;
  tokens: number;
  cost: number;
  stoppable: boolean;
  kind: RunKind;
  n: number;
  /** The spec was concluded: the run is read-only and nothing new starts for that spec. */
  locked: boolean;
  /** Interrupted after the user stopped it. */
  stopped?: boolean;
}
export interface SpecRow {
  specId: string;
  status: string;
  activeRunId: string | null;
}
export interface ProjectRow {
  projectId: string;
  dir: string;
  name: string;
  description: string;
  specs: SpecRow[];
  /** The services of project.json, one repository each. */
  services?: string[];
  /** The shared containers of project.json, by name and image. */
  platform?: Array<{ name: string; image: string }>;
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
/** The pid file holds a bare number (all it used to hold) or `{"pid":N,"start":"..."}`, where `start` is what the OS
 * reported for the process when the file was written (see process-identity.ts). */
function parsePidFile(text: string | null): { pid: number; start?: string } | null {
  const t = (text ?? '').trim();
  const n = Number(t);
  if (Number.isInteger(n) && n > 0) return { pid: n };
  try {
    const rec: unknown = JSON.parse(t);
    const { pid, start } = (typeof rec === 'object' && rec !== null ? rec : {}) as { pid?: unknown; start?: unknown };
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) return typeof start === 'string' ? { pid, start } : { pid };
  } catch {
    /* not JSON either */
  }
  return null;
}
/** The pid of the run's process. A pid file can outlive its process (reboot, container restart, plain reuse) and the number
 * then names whatever got it next, so a recorded start that no longer matches the live process retires the file like a dead
 * pid and returns null: callers must never signal that number. A bare pid, or a pid with no process behind it, comes back
 * as it is for the liveness check to judge. */
export async function readPid(runs: string, runId: string): Promise<number | null> {
  const text = await fs.readFile(pidFile(runs, runId), 'utf8').catch(() => null);
  const rec = parsePidFile(text);
  if (rec?.start !== undefined) {
    const live = await probeProcess(rec.pid);
    if (live !== null && live.start !== rec.start) {
      // Retire the file that was judged, not one a launch wrote while the OS was being asked.
      if ((await fs.readFile(pidFile(runs, runId), 'utf8').catch(() => null)) === text) await clearPid(runs, runId);
      return null;
    }
  }
  return rec?.pid ?? null;
}
/** Records the start of the process next to its pid, but only when that process carries this run's id on its command line;
 * a pid that is not (or not yet) the run's process is written bare, as before. */
export async function writePid(runs: string, runId: string, pid: number): Promise<void> {
  const live = await probeProcess(pid);
  await fs.rm(`${pidFile(runs, runId)}.gone`, { force: true });
  await fs.writeFile(pidFile(runs, runId), live?.argv.includes(runId) ? JSON.stringify({ pid, start: live.start }) : String(pid));
}
/** The stale pid file becomes `pid.gone`: the run keeps showing interrupted until it is resumed or finished. A `judged` pid
 * retires the file only while it still names that pid, so a launch that wrote its own in the meantime keeps it. */
export async function clearPid(runs: string, runId: string, judged?: number): Promise<void> {
  if (judged !== undefined && (await readPid(runs, runId)) !== judged) return;
  await fs.rename(pidFile(runs, runId), `${pidFile(runs, runId)}.gone`).catch(() => undefined);
}
async function wasInterrupted(runs: string, runId: string): Promise<boolean> {
  return fs.access(`${pidFile(runs, runId)}.gone`).then(
    () => true,
    () => false,
  );
}

// The user's Stop, on disk because the supervisor is another process and the journal belongs to the process being
// stopped. Unlike a RUN_STOP_REQUESTED event (which drains the run for good) it can be lifted: a resume clears it.
const stopFile = (runs: string, runId: string) => path.join(runs, runId, 'stop-requested');
export async function markStopRequested(runs: string, runId: string): Promise<void> {
  await fs.writeFile(stopFile(runs, runId), '');
}
export async function clearStopRequested(runs: string, runId: string): Promise<void> {
  await fs.rm(stopFile(runs, runId), { force: true });
}
export async function isStopRequested(runs: string, runId: string): Promise<boolean> {
  return fs.access(stopFile(runs, runId)).then(
    () => true,
    () => false,
  );
}

const claimFile = (runs: string, runId: string) => path.join(runs, runId, 'launch-claim');
/** A launch waits at most ~10 s for the journal; a claim older than this belongs to a spawner that died mid-launch. */
const CLAIM_TTL_MS = 60_000;
/** The exclusive (O_EXCL) right to start a process for a run, shared by the resume route and the supervisor so that
 * exactly one of them spawns. Returns the release function, or null while another spawner holds the claim. */
export async function claimLaunch(runs: string, runId: string): Promise<(() => Promise<void>) | null> {
  const file = claimFile(runs, runId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await (await fs.open(file, 'wx')).close();
      return () => fs.rm(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const since = (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0; // gone already: released just now
      if (Date.now() - since < CLAIM_TTL_MS) return null;
      await fs.rm(file, { force: true });
    }
  }
  return null;
}

interface StateFile {
  at?: string;
  status?: string;
  tokens?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/** What the pid files say about the process of a run. `interrupted` means it started from the UI and died: a pid file
 * naming a dead process (retired to `pid.gone` here, so the answer survives) or a `pid.gone` left by an earlier look.
 * A run with no pid file at all (started from a terminal) is never judged interrupted. The journal cannot tell:
 * a killed process writes nothing, so a run that did not finish keeps reading as running. */
export async function runLiveness(deps: IndexDeps, runId: string): Promise<{ alive: boolean; interrupted: boolean }> {
  const runs = runsDir(deps);
  const pid = await readPid(runs, runId);
  const alive = pid !== null && deps.isAlive(pid);
  if (pid !== null && !alive) await clearPid(runs, runId, pid);
  return { alive, interrupted: (pid !== null && !alive) || (pid === null && (await wasInterrupted(runs, runId))) };
}

/** A run a human reopened runs again: only a RUN_FINISHED after the last reopening says it ended. */
export function finishOf<E extends { type: string }>(events: readonly E[]): E | undefined {
  const lastFinish = events.findLastIndex((e) => e.type === 'RUN_FINISHED');
  return lastFinish > events.findLastIndex((e) => e.type === 'RUN_REOPENED') ? events[lastFinish] : undefined;
}

export async function runRow(deps: IndexDeps, runId: string): Promise<RunRow | null> {
  const runs = runsDir(deps);
  const events = await loadEvents(path.join(runs, runId, 'events.ndjson')).catch(() => []);
  const startedAt = events.find((e) => e.type === 'RUN_STARTED');
  const parsed = parseRunId(runId);
  const specId = String(startedAt?.data.specId ?? parsed?.specId ?? runId);
  const projectId = startedAt ? String(startedAt.data.projectId) : parsed?.projectId ?? null;
  const finished = finishOf(events);
  const state: StateFile | null = await fs
    .readFile(path.join(runs, runId, 'state.json'), 'utf8')
    .then((t) => JSON.parse(t) as StateFile)
    .catch(() => null);
  const { alive, interrupted } = await runLiveness(deps, runId);
  // A launch that never wrote its journal leaves only ui.log behind.
  const launchLog = events.length === 0 && !state ? await fs.stat(path.join(runs, runId, 'ui.log')).catch(() => null) : null;
  let status: RunListStatus;
  if (finished) status = String(finished.data.result) as RunListStatus;
  // Phases 0-2 journal before the first state snapshot: a live process is running, not unknown (the spec must stay claimed).
  else if (!state?.status) status = alive ? 'running' : events.length === 0 && launchLog ? 'launch-failed' : 'unknown';
  // A run paused by an expired login exits on purpose and waits for a human, not for a resume on the same login.
  else if (interrupted && state.status !== 'paused:auth') status = 'interrupted';
  else status = state.status as RunListStatus;
  const stopped = status === 'interrupted' && (await isStopRequested(runs, runId));
  const tokens = (state?.tokens?.inputTokens ?? 0) + (state?.tokens?.outputTokens ?? 0);
  return { runId, specId, projectId: projectId ?? '', status, at: state?.at ?? finished?.at ?? launchLog?.mtime.toISOString() ?? null, tokens, cost: state?.tokens?.costUsd ?? 0, stoppable: alive && ACTIVE.has(status), kind: parsed?.kind ?? 'run', n: parsed?.n ?? 0, locked: false, ...(stopped ? { stopped } : {}) };
}

type Read = Awaited<ReturnType<typeof readProject>>;

/** Each project's readable dirs in registration order: a started refinement registers its own dir, so one project spans several. */
async function projectDirs(deps: IndexDeps): Promise<Map<string, Array<{ dir: string; read: Read }>>> {
  const out = new Map<string, Array<{ dir: string; read: Read }>>();
  for (const { dir } of deps.cfg.projects) {
    const read = await readProject(dir).catch(() => null);
    if (read) out.set(read.project.projectId, [...(out.get(read.project.projectId) ?? []), { dir, read }]);
  }
  return out;
}

/** One entry per spec: its own refinement dir speaks for it, else the first dir that carries a copy. A run started from the clone moves only main past `running`, so a copy already delivered beats the stale own one. */
function mergeSpecs(dirs: ReadonlyArray<{ dir: string; read: Read }>): Read['specs'] {
  const out = new Map<string, Read['specs'][number]>();
  const delivered = (s?: Read['specs'][number]) => s?.status === 'awaiting-validation' || s?.status === 'done';
  for (const { dir, read } of dirs) for (const s of read.specs) if (!out.has(s.specId) || (path.basename(dir) === s.specId && !(s.status === 'running' && delivered(out.get(s.specId))))) out.set(s.specId, s);
  return [...out.values()];
}

async function specsOf(deps: IndexDeps, projectId: string): Promise<Map<string, string>> {
  return new Map(mergeSpecs((await projectDirs(deps)).get(projectId) ?? []).map((s) => [s.specId, s.status]));
}

export async function listRuns(deps: IndexDeps, projectId: string): Promise<RunRow[]> {
  const runs = runsDir(deps);
  const names = (await fs.readdir(runs).catch(() => [] as string[])).filter((n) => SAFE_ID.test(n));
  // A run that crashed before RUN_STARTED has no project in its journal; its id still names the spec.
  const specs = await specsOf(deps, projectId);
  const rows: RunRow[] = [];
  for (const runId of names) {
    const row = await runRow(deps, runId);
    if (!row) continue;
    if (row.projectId === projectId || (row.projectId === '' && specs.has(row.specId))) rows.push({ ...row, projectId });
  }
  // newest first: runs without a state snapshot (just started) on top, then by state timestamp, then by the numeric suffix
  rows.sort((a, b) => {
    if ((a.at === null) !== (b.at === null)) return a.at === null ? -1 : 1;
    return (b.at ?? '').localeCompare(a.at ?? '') || b.n - a.n;
  });
  // Concluding a spec runs a new `complete` run and never touches the journal of the run that delivered it, which would
  // read "awaiting validation" forever. The newest such run turns done once the spec is: its spec file says so, or a
  // completion run after it finished done (a draft root never sees the `done` merged onto main). Older runs keep their own.
  const completed = new Set([...specs].filter(([, status]) => status === 'done').map(([specId]) => specId));
  const settled = new Set<string>();
  for (const row of rows) {
    if (row.status === 'done' && row.kind === 'complete') completed.add(row.specId);
    else if (row.status === 'awaiting-validation' && completed.has(row.specId) && !settled.has(row.specId)) {
      settled.add(row.specId);
      row.status = 'done';
    }
  }
  const concluded = concludedSpecs(specs, rows);
  for (const row of rows) row.locked = concluded.has(row.specId);
  return rows;
}

/** A spec is concluded when its spec file says done or one of its completion runs finished done. */
export function concludedSpecs(specs: ReadonlyMap<string, string>, rows: readonly RunRow[]): Set<string> {
  const done = [...specs].filter(([, status]) => status === 'done').map(([specId]) => specId);
  return new Set([...done, ...rows.filter((r) => r.kind === 'complete' && r.status === 'done').map((r) => r.specId)]);
}


export async function listProjects(deps: IndexDeps): Promise<ProjectRow[]> {
  const out: ProjectRow[] = [];
  for (const [projectId, dirs] of await projectDirs(deps)) {
    // The newest dir carries the latest project docs.
    const { dir, read } = dirs.at(-1)!;
    const specs = mergeSpecs(dirs);
    const runs = await listRuns(deps, projectId);
    // `spec complete` finishes by merging `status: done` onto main; the draft root this project reads its specs
    // from keeps whatever status the freeze left it, since nothing patches it back once that merge lands. The
    // completion run's own journal is ground truth for whether the spec is actually done.
    const completed = concludedSpecs(new Map(specs.map((s) => [s.specId, s.status])), runs);
    out.push({
      projectId,
      dir,
      name: read.project.name,
      description: read.project.vision,
      specs: specs.map((s) => ({ specId: s.specId, status: completed.has(s.specId) ? 'done' : s.status, activeRunId: runs.find((r) => r.specId === s.specId && claimsSpec(r))?.runId ?? null })),
      ...(read.project.services ? { services: read.project.services } : {}),
      ...(read.project.platform ? { platform: read.project.platform.map((p) => ({ name: p.name, image: p.image })) } : {}),
    });
  }
  return out;
}
