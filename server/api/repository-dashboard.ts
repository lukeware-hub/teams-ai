import { ROLES } from '../config/roles.js';
import { describeAll, stepDoing, type ActivityTone } from '../orchestrator/event-text.js';
import { explainBlockReason, firstSentence } from '../orchestrator/stop-explain.js';
import { reduceEvents, type TaskRuntime } from '../pipeline/run-state.js';
import { DEPENDENCY_BLOCKED } from '../pipeline/task-state.js';
import { parseRunId } from '../core/ids.js';
import { loadEvents, type StoredEvent } from '../store/event-store.js';
import path from 'node:path';

/** A list shown up to its cap; `total` counts every item. */
export interface Capped<T> {
  total: number;
  list: T[];
}

export const CAPS = { tasks: 500, runs: 200, failures: 100, files: 100, tests: 50, timeline: 200 } as const;

export type SpecState = 'delivered' | 'awaiting' | 'failed' | 'blocked' | 'running' | 'pending' | 'not-started';
export type TaskState = 'delivered' | 'running' | 'pending' | 'blocked' | 'failed';

const ALIVE: ReadonlySet<string> = new Set(['running', 'draining']);
const FAILED_RUN: ReadonlySet<string> = new Set(['phase-failed', 'verification-failed', 'deploy-failed', 'launch-failed']);
const BLOCKED_RUN: ReadonlySet<string> = new Set(['blocked', 'deadlocked', 'paused:quota', 'paused:auth']);
const ACTIVE_TASK: ReadonlySet<string> = new Set(['implementing', 'validating', 'reviewing', 'rebasing', 'merging']);
const RUN_FAILURE_LABEL: Record<string, string> = {
  'phase-failed': 'falhou em uma fase',
  'verification-failed': 'verificação reprovada',
  'deploy-failed': 'deploy falhou',
  'launch-failed': 'não chegou a iniciar',
  interrupted: 'interrompida sem parada do dono',
};

/** One run of the repository's specs, with its journal as read. */
export interface DashboardRun {
  runId: string;
  specId: string;
  kind: string;
  n: number;
  status: string;
  at: string | null;
  cost: number;
  stopped: boolean;
  events: StoredEvent[];
}

export interface DashboardSpecInput {
  specId: string;
  title: string | null;
  priority: string | null;
  status: string;
  /** The tasks in the spec's task list. */
  tasks: number;
  plan: boolean;
  blocked: boolean;
  activeRunId: string | null;
}

export interface DashboardInput {
  specs: DashboardSpecInput[];
  runs: DashboardRun[];
  /** The owner's pending blocking questions of the repository. */
  questions: string[];
  missingSecrets: string[];
  programStops: Array<{ specId: string; reason: string }>;
}

export interface DashboardSpec {
  specId: string;
  title: string | null;
  priority: string | null;
  status: string;
  state: SpecState;
  total: number;
  delivered: number;
  running: number;
  pending: number;
  blocked: number;
  failed: number;
}

export interface DashboardTask {
  specId: string;
  runId: string | null;
  taskId: string;
  title: string;
  owner: string;
  state: TaskState;
  attempts: number;
  reason: string | null;
  pr: number | null;
}

export interface DashboardItem {
  kind: 'task' | 'run' | 'question' | 'secret' | 'stop';
  specId: string | null;
  runId: string | null;
  taskId: string | null;
  text: string;
}

export interface DashboardRunRow {
  runId: string;
  specId: string;
  kind: string;
  status: string;
  at: string | null;
  merged: number;
  cost: number;
}

export interface RoleActivity {
  role: string;
  steps: number;
  ok: number;
  failed: number;
  tokens: number;
  costUsd: number;
  durationMs: number;
  /** Tasks the role owns; null for a role that owns no task. */
  created: number | null;
  started: number | null;
  finished: number | null;
  files: number;
  /** Test cases the role ran; only the test role runs them. */
  tests: { passed: number; failed: number } | null;
  lastAt: string;
  lastDoing: string;
}

export interface TimelineEntry {
  at: string;
  runId: string;
  specId: string;
  text: string;
  tone: ActivityTone;
  role: string | null;
  taskId: string | null;
}

export interface LastDeploy {
  runId: string;
  specId: string;
  url: string | null;
  /** What the plan declared the service is: api, front or mobile; null for a deploy from before the plan declared it. */
  kind: string | null;
  docsPath: string | null;
  services: Array<{ service: string; url: string | null; docsPath: string | null }> | null;
}

export interface RepoDashboard {
  counts: {
    tasks: number;
    delivered: number;
    pending: number;
    running: number;
    blocked: number;
    failed: number;
    runs: number;
    runsActive: number;
    failures: number;
    blockers: number;
    specsDelivered: number;
    specsAwaiting: number;
    progress: number | null;
    /** US$ spent by the repository's runs: the sum of the runs' cost, as the runs table shows it. */
    cost: number;
  };
  specs: DashboardSpec[];
  tasks: Capped<DashboardTask>;
  runs: Capped<DashboardRunRow>;
  failures: Capped<DashboardItem>;
  blockers: Capped<DashboardItem>;
  agents: RoleActivity[];
  files: Capped<{ path: string; taskId: string }>;
  tests: { passed: number; failed: number; failures: Capped<{ taskId: string; gate: string; name: string }> };
  retries: { attempts: number; infra: number; flaky: number; replanned: number; fixes: number; reopened: number };
  timeline: Capped<TimelineEntry>;
  lastDeploy: LastDeploy | null;
}

const cap = <T>(all: T[], n: number): Capped<T> => ({ total: all.length, list: all.slice(0, n) });
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The tasks a journal replays to; null when it does not replay. */
function tasksOf(events: StoredEvent[]): Map<string, TaskRuntime> | null {
  try {
    return reduceEvents(events).tasks;
  } catch {
    return null;
  }
}

/** The last reason each task blocked with, and the tasks the owner was asked about. */
function blocks(events: StoredEvent[]): { reasons: Map<string, string>; asked: Set<string> } {
  const reasons = new Map<string, string>();
  const asked = new Set<string>();
  for (const e of events) {
    const id = str(e.data.taskId);
    if (id === null) continue;
    if (e.type === 'TASK_BLOCKED') reasons.set(id, String(e.data.reason ?? ''));
    if (e.type === 'DECISION_REQUESTED') asked.add(id);
  }
  return { reasons, asked };
}

function taskStateOf(rt: TaskRuntime, run: DashboardRun, reason: string | undefined, asked: boolean): TaskState | null {
  if (rt.state === 'superseded') return null;
  if (rt.state === 'merged') return 'delivered';
  // A block on a dependency or waiting on the owner waits; a block on its own cause failed.
  if (rt.state === 'blocked') return reason === DEPENDENCY_BLOCKED || asked ? 'blocked' : 'failed';
  if (ACTIVE_TASK.has(rt.state) && ALIVE.has(run.status)) return 'running';
  return 'pending';
}

function specStateOf(spec: DashboardSpecInput, runs: DashboardRun[], dash: DashboardSpec): SpecState {
  const last = runs.at(-1);
  if (spec.status === 'done') return 'delivered';
  if (spec.status === 'awaiting-validation') return 'awaiting';
  if ((last !== undefined && FAILED_RUN.has(last.status)) || dash.failed > 0) return 'failed';
  if (dash.blocked > 0 || spec.blocked || (last !== undefined && BLOCKED_RUN.has(last.status))) return 'blocked';
  if (dash.running > 0 || spec.activeRunId !== null || (last !== undefined && ALIVE.has(last.status))) return 'running';
  if (spec.plan || runs.length > 0) return 'pending';
  return 'not-started';
}

/** A spec's tasks across its runs: one state per task id, a merge in any run wins, a superseded task counts nowhere. */
function specTasks(spec: DashboardSpecInput, runs: DashboardRun[], tasksByRun: Map<string, Map<string, TaskRuntime> | null>) {
  const best = new Map<string, DashboardTask>();
  const plannedPlan = new Set<string>();
  // The newest run with a task list: a task it does not carry is history, unless it merged.
  const current = runs.filter((r) => r.kind === 'run' && tasksByRun.get(r.runId)).at(-1);
  for (const run of runs) {
    const tasks = tasksByRun.get(run.runId);
    if (!tasks) continue;
    const { reasons, asked } = blocks(run.events);
    const prs = new Map<string, number>();
    for (const e of run.events) if (e.type === 'PR_MERGED' && str(e.data.taskId) !== null) prs.set(String(e.data.taskId), num(e.data.pr));
    for (const rt of tasks.values()) {
      const id = rt.def.id;
      if (rt.def.origin === 'plan') plannedPlan.add(id);
      const reason = reasons.get(id);
      const state = taskStateOf(rt, run, reason, asked.has(id));
      const prev = best.get(id);
      if (prev?.state === 'delivered' && state !== 'delivered') continue;
      if (state === null) {
        best.delete(id);
        continue;
      }
      if (state !== 'delivered' && run !== current) continue;
      best.set(id, {
        specId: spec.specId,
        runId: run.runId,
        taskId: id,
        title: rt.def.title,
        owner: rt.def.owner,
        state,
        attempts: rt.attempts,
        reason: reason === undefined ? null : firstSentence(explainBlockReason(reason)),
        pr: prs.get(id) ?? null,
      });
    }
  }
  return { rows: [...best.values()], plannedPlan };
}

function specView(spec: DashboardSpecInput, runs: DashboardRun[], tasksByRun: Map<string, Map<string, TaskRuntime> | null>): { view: DashboardSpec; rows: DashboardTask[] } {
  const { rows, plannedPlan } = specTasks(spec, runs, tasksByRun);
  const done = spec.status === 'done';
  const notStarted = done ? 0 : Math.max(0, spec.tasks - plannedPlan.size);
  // A spec delivered before journals existed: its task list counts as delivered.
  const fallback = done && rows.length === 0 ? spec.tasks : 0;
  const count = (s: TaskState) => rows.filter((r) => r.state === s).length;
  const view: DashboardSpec = {
    specId: spec.specId,
    title: spec.title,
    priority: spec.priority,
    status: spec.status,
    state: 'not-started',
    total: rows.length + notStarted + fallback,
    delivered: count('delivered') + fallback,
    running: count('running'),
    pending: count('pending') + notStarted,
    blocked: count('blocked'),
    failed: count('failed'),
  };
  view.state = specStateOf(spec, runs, view);
  return { view, rows };
}

/** The runs of a project in the dashboard's shape, each with its journal read once; a journal that cannot be read gives no events. */
export async function loadRepoRuns(runsDir: string, rows: ReadonlyArray<{ runId: string; specId: string; n: number; status: string; at: string | null; cost: number; stopped?: boolean }>): Promise<DashboardRun[]> {
  return Promise.all(
    rows.map(async (r) => ({
      runId: r.runId,
      specId: r.specId,
      kind: parseRunId(r.runId)?.kind ?? 'run',
      n: r.n,
      status: r.status,
      at: r.at,
      cost: r.cost,
      stopped: r.stopped === true,
      events: await loadEvents(path.join(runsDir, r.runId, 'events.ndjson')).catch(() => [] as StoredEvent[]),
    })),
  );
}

/** Each spec's counts and task rows from its runs; the runs whose journal does not replay are in `unreadable`. */
export function specViews(specs: DashboardSpecInput[], runs: DashboardRun[]): { specs: DashboardSpec[]; tasks: DashboardTask[]; unreadable: Set<string> } {
  const tasksByRun = new Map(runs.map((r) => [r.runId, tasksOf(r.events)] as const));
  const out = { specs: [] as DashboardSpec[], tasks: [] as DashboardTask[], unreadable: new Set(runs.filter((r) => tasksByRun.get(r.runId) === null).map((r) => r.runId)) };
  for (const spec of specs) {
    const { view, rows } = specView(spec, runs.filter((r) => r.specId === spec.specId).sort((a, b) => a.n - b.n), tasksByRun);
    out.specs.push(view);
    out.tasks.push(...rows);
  }
  return out;
}

/** The dashboard of a repository from its specs and runs. Reads no file: the caller gives the journals. */
export function buildDashboard(input: DashboardInput): RepoDashboard {
  const { specs, tasks, unreadable } = specViews(input.specs, input.runs);
  const owners = new Map(tasks.map((t) => [`${t.specId}/${t.taskId}`, t.owner]));
  const sum = (key: 'total' | 'delivered' | 'running' | 'pending' | 'blocked' | 'failed') => specs.reduce((acc, s) => acc + s[key], 0);

  const failures: DashboardItem[] = [];
  const blockers: DashboardItem[] = [];
  // A run that a newer run of its spec finished is history: the spec moved on.
  const movedOn = (run: DashboardRun) => run.kind === 'run' && input.runs.some((o) => o.specId === run.specId && o.kind === 'run' && o.status === 'done' && o.n > run.n);
  for (const t of tasks) {
    if (t.state === 'failed') failures.push({ kind: 'task', specId: t.specId, runId: t.runId, taskId: t.taskId, text: `Tarefa ${t.taskId}: ${t.reason ?? 'motivo não registrado'}` });
    if (t.state === 'blocked') blockers.push({ kind: 'task', specId: t.specId, runId: t.runId, taskId: t.taskId, text: `Tarefa ${t.taskId}: ${t.reason ?? 'motivo não registrado'}` });
  }
  for (const run of input.runs) {
    if (unreadable.has(run.runId)) failures.push({ kind: 'run', specId: run.specId, runId: run.runId, taskId: null, text: `Run ${run.runId}: journal não pôde ser lido` });
    if ((FAILED_RUN.has(run.status) || (run.status === 'interrupted' && !run.stopped)) && !movedOn(run)) {
      failures.push({ kind: 'run', specId: run.specId, runId: run.runId, taskId: null, text: `Run ${run.runId}: ${RUN_FAILURE_LABEL[run.status] ?? run.status}` });
    }
    if (run.status === 'paused:quota' || run.status === 'paused:auth') {
      const why = run.status === 'paused:quota' ? 'limite de uso dos modelos' : 'sessão do Claude expirou';
      blockers.push({ kind: 'run', specId: run.specId, runId: run.runId, taskId: null, text: `Run ${run.runId} pausada: ${why}` });
    }
  }
  for (const text of input.questions) blockers.push({ kind: 'question', specId: null, runId: null, taskId: null, text });
  for (const name of input.missingSecrets) blockers.push({ kind: 'secret', specId: null, runId: null, taskId: null, text: `Segredo ${name} não está no cofre` });
  for (const stop of input.programStops) blockers.push({ kind: 'stop', specId: stop.specId, runId: null, taskId: null, text: stop.reason });

  const agents = new Map<string, { steps: number; ok: number; failed: number; tokens: number; costUsd: number; durationMs: number; files: Set<string>; passed: number; testFailed: number; lastAt: string; lastDoing: string }>();
  const agentOf = (role: string) => {
    if (!agents.has(role)) agents.set(role, { steps: 0, ok: 0, failed: 0, tokens: 0, costUsd: 0, durationMs: 0, files: new Set(), passed: 0, testFailed: 0, lastAt: '', lastDoing: '' });
    return agents.get(role)!;
  };
  const fileList: Array<{ path: string; taskId: string }> = [];
  const seenFiles = new Set<string>();
  const testFailures: Array<{ taskId: string; gate: string; name: string }> = [];
  let testsPassed = 0;
  let testsFailed = 0;
  const retries = { attempts: 0, infra: 0, flaky: 0, replanned: 0, fixes: 0, reopened: 0 };
  const timeline: TimelineEntry[] = [];
  let lastDeploy: LastDeploy | null = null;

  // Oldest first, so the last deploy and the last step of each agent are the newest ones.
  const oldestFirst = [...input.runs].sort((a, b) => a.n - b.n);
  for (const run of oldestFirst) {
    const started = new Map<string, { role: string; kind: string; taskId: string | null }>();
    for (const e of run.events) {
      const d = e.data;
      if (e.type === 'ATTEMPT_CONSUMED') retries.attempts += 1;
      if (e.type === 'INFRA_RETRY') retries.infra += 1;
      if (e.type === 'FLAKY_RETRY') retries.flaky += 1;
      if (e.type === 'TASK_REPLANNED') retries.replanned += 1;
      if (e.type === 'FIX_TASKS_PLANNED') retries.fixes += Array.isArray(d.tasks) ? d.tasks.length : 0;
      if (e.type === 'RUN_REOPENED') retries.reopened += 1;
      if (e.type === 'DEPLOY_VERIFIED') {
        const services = Array.isArray(d.services) ? (d.services as Array<Record<string, unknown>>).map((s) => ({ service: String(s.service), url: str(s.url), docsPath: str(s.docsPath) })) : null;
        lastDeploy = { runId: run.runId, specId: run.specId, url: str(d.url), kind: str(d.kind), docsPath: str(d.docsPath), services };
      }
      if (e.type === 'STEP_STARTED') started.set(String(d.stepId), { role: String(d.role), kind: String(d.kind), taskId: str(d.taskId) });
      if (e.type === 'STEP_FINISHED') {
        const s = started.get(String(d.stepId));
        if (!s) continue;
        const a = agentOf(s.role);
        a.steps += 1;
        if (d.ok === true) a.ok += 1;
        else a.failed += 1;
        const usage = d.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        a.tokens += num(usage?.inputTokens) + num(usage?.outputTokens);
        a.costUsd += num(d.costUsd);
        a.durationMs += num(d.durationMs);
        if (e.at >= a.lastAt) {
          a.lastAt = e.at;
          a.lastDoing = stepDoing(s.kind);
        }
      }
      if (e.type === 'DEV_COMMITTED') {
        const taskId = str(d.taskId) ?? '';
        const owner = owners.get(`${run.specId}/${taskId}`);
        const changed = Array.isArray(d.changedFiles) ? (d.changedFiles as string[]) : [];
        for (const file of changed) {
          if (owner !== undefined) agentOf(owner).files.add(file);
          if (!seenFiles.has(file)) {
            seenFiles.add(file);
            fileList.push({ path: file, taskId });
          }
        }
      }
      if (e.type === 'GATE_PASSED' || e.type === 'GATE_FAILED') {
        const gate = String(d.gate ?? '');
        const junit = Array.isArray(d.junit) ? (d.junit as Array<{ name?: unknown; status?: unknown }>) : [];
        for (const t of junit) {
          if (t.status === 'passed') testsPassed += 1;
          if (t.status === 'failed') {
            testsFailed += 1;
            testFailures.push({ taskId: str(d.taskId) ?? '', gate, name: String(t.name ?? '') });
          }
        }
        const a = agentOf('test');
        a.passed += junit.filter((t) => t.status === 'passed').length;
        a.testFailed += junit.filter((t) => t.status === 'failed').length;
      }
    }
  }

  const agentRows: RoleActivity[] = [...ROLES, ...[...agents.keys()].filter((r) => !(ROLES as readonly string[]).includes(r))].flatMap((role) => {
    const a = agents.get(role);
    const owned = tasks.filter((t) => t.owner === role);
    const isOwner = role === 'dev' || role === 'devops' || role === 'front';
    if (!a && owned.length === 0) return [];
    const row: RoleActivity = {
      role,
      steps: a?.steps ?? 0,
      ok: a?.ok ?? 0,
      failed: a?.failed ?? 0,
      tokens: a?.tokens ?? 0,
      costUsd: a?.costUsd ?? 0,
      durationMs: a?.durationMs ?? 0,
      created: isOwner ? owned.length : null,
      started: isOwner ? owned.filter((t) => t.state !== 'pending').length : null,
      finished: isOwner ? owned.filter((t) => t.state === 'delivered').length : null,
      files: a?.files.size ?? 0,
      tests: role === 'test' ? { passed: a?.passed ?? 0, failed: a?.testFailed ?? 0 } : null,
      lastAt: a?.lastAt ?? '',
      lastDoing: a?.lastDoing ?? '',
    };
    return [row];
  });

  for (const run of oldestFirst) {
    const started = new Map<string, string>();
    describeAll(run.events, (e, item) => {
      const d = e.data;
      if (e.type === 'STEP_STARTED') started.set(String(d.stepId), String(d.role));
      const role = e.type === 'STEP_FINISHED' ? (started.get(String(d.stepId)) ?? null) : null;
      if (item) {
        timeline.push({ at: e.at, runId: run.runId, specId: run.specId, text: item.text, tone: item.tone, role, taskId: str(d.taskId) });
      } else if (e.type === 'STEP_FINISHED' && d.ok === true && role !== null) {
        timeline.push({ at: e.at, runId: run.runId, specId: run.specId, text: `Etapa ${stepDoing(String(d.kind))} concluída`, tone: '', role, taskId: str(d.taskId) });
      }
    });
  }
  timeline.sort((a, b) => b.at.localeCompare(a.at));

  const runRows: DashboardRunRow[] = input.runs
    .map((run) => ({
      runId: run.runId,
      specId: run.specId,
      kind: run.kind,
      status: run.status,
      at: run.at,
      merged: run.events.filter((e) => e.type === 'PR_MERGED').length,
      cost: run.cost,
    }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

  const delivered = sum('delivered');
  const total = sum('total');
  return {
    counts: {
      tasks: total,
      delivered,
      pending: sum('pending'),
      running: sum('running'),
      blocked: sum('blocked'),
      failed: sum('failed'),
      runs: input.runs.length,
      runsActive: input.runs.filter((r) => ALIVE.has(r.status)).length,
      failures: failures.length,
      blockers: blockers.length,
      specsDelivered: specs.filter((s) => s.state === 'delivered').length,
      specsAwaiting: specs.filter((s) => s.state === 'awaiting').length,
      progress: total > 0 ? Math.round((delivered / total) * 100) : null,
      cost: input.runs.reduce((sum, r) => sum + r.cost, 0),
    },
    specs,
    tasks: cap(tasks, CAPS.tasks),
    runs: cap(runRows, CAPS.runs),
    failures: cap(failures, CAPS.failures),
    blockers: cap(blockers, CAPS.failures),
    agents: agentRows,
    files: cap(fileList, CAPS.files),
    tests: { passed: testsPassed, failed: testsFailed, failures: cap(testFailures, CAPS.tests) },
    retries,
    timeline: cap(timeline, CAPS.timeline),
    lastDeploy,
  };
}
