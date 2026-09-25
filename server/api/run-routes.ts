import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StepKind } from '../agents/outputs.js';
import { Accounting } from '../budget/accounting.js';
import type { Config, Role } from '../config/config.js';
import { addProject } from '../onboarding/config-store.js';
import { nextRunId } from '../orchestrator/workspace.js';
import { reduceEvents } from '../pipeline/run-state.js';
import { EventLogCorruptError, loadEvents, type StoredEvent } from '../store/event-store.js';
import { tailJournal } from './journal-tail.js';
import { isAlive, spawnRun, stop, type RunControlDeps } from './run-control.js';
import { CLAIMS_SPEC, clearPid, listProjects, listRuns, readPid, readProject, runsDir, SAFE_ID, writePid, type IndexDeps, type RunRow } from './run-index.js';
import { HttpError, type Route } from './server.js';

export interface RunRoutesDeps {
  cfg: () => Promise<Config>;
  home?: string;
  control: RunControlDeps;
  log?: (line: string) => void;
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>)[field] !== 'string') throw new HttpError(400, `${field} must be a string`);
  return (v as Record<string, string>)[field]!;
};

export function runRoutes(deps: RunRoutesDeps): Route[] {
  const index = async (): Promise<IndexDeps> => ({ cfg: await deps.cfg(), home: deps.home, isAlive: (pid) => isAlive(deps.control, pid) });
  const projectDir = async (idx: IndexDeps, projectId: string): Promise<string> => {
    for (const { dir } of idx.cfg.projects) {
      const read = await readProject(dir).catch(() => null);
      if (read?.project.projectId === projectId) return dir;
    }
    throw new HttpError(404, `unknown project ${projectId}`);
  };
  const safe = (id: string): string => {
    if (!SAFE_ID.test(id)) throw new HttpError(400, `invalid id ${JSON.stringify(id)}`);
    return id;
  };
  const events = async (runs: string, runId: string): Promise<StoredEvent[]> => {
    const file = path.join(runs, runId, 'events.ndjson');
    await fs.access(file).catch(() => {
      throw new HttpError(404, `unknown run ${runId}`);
    });
    try {
      return await loadEvents(file);
    } catch (err) {
      if (err instanceof EventLogCorruptError) throw new HttpError(500, 'journal corrupt; run teams-ai status --repair');
      throw err;
    }
  };
  const tokensOf = (evs: StoredEvent[]) => {
    const acc = new Accounting();
    const started = new Map<string, Record<string, unknown>>();
    for (const e of evs) {
      if (e.type === 'STEP_STARTED') started.set(String(e.data.stepId), e.data);
      if (e.type !== 'STEP_FINISHED') continue;
      const s = started.get(String(e.data.stepId));
      const usage = e.data.usage as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
      if (!s || !usage) continue;
      acc.record({
        role: s.role as Role,
        phase: e.data.taskId ? 'phase3' : 'phase',
        taskId: (e.data.taskId as string | null) ?? null,
        attempt: Number(e.data.attempt ?? 0),
        stepKind: e.data.kind as StepKind,
        provider: 'claude',
        model: 'unknown',
        usage,
        costUsd: (e.data.costUsd as number | null) ?? null,
        durationMs: Number(e.data.durationMs ?? 0),
        numTurns: Number(e.data.numTurns ?? 0),
        at: e.at,
      });
    }
    return acc.total();
  };
  const findRun = async (idx: IndexDeps, runId: string): Promise<{ row: RunRow; dir: string }> => {
    const runs = runsDir(idx);
    const evs = await events(runs, runId);
    const projectId = String(evs.find((e) => e.type === 'RUN_STARTED')?.data.projectId ?? '');
    const row = (await listRuns(idx, projectId)).find((r) => r.runId === runId);
    if (!row) throw new HttpError(404, `unknown run ${runId}`);
    return { row, dir: await projectDir(idx, projectId) };
  };
  const waitForJournal = async (runs: string, runId: string, pid: number, timeoutMs = 10_000): Promise<void> => {
    const file = path.join(runs, runId, 'events.ndjson');
    for (let waited = 0; waited < timeoutMs; waited += 200) {
      if (
        await fs.access(file).then(
          () => true,
          () => false,
        )
      )
        return;
      if (!isAlive(deps.control, pid)) break;
      await deps.control.sleep(200);
    }
    const log = await fs.readFile(path.join(runs, runId, 'ui.log'), 'utf8').catch(() => '');
    throw new HttpError(500, `run ${runId} did not start: ${log.slice(-500) || 'no output'}`);
  };
  const launch = async (idx: IndexDeps, o: { projectDir: string; specId: string; runId: string; mode: 'run' | 'resume' }): Promise<void> => {
    const runs = runsDir(idx);
    await fs.mkdir(path.join(runs, o.runId), { recursive: true });
    const { pid } = spawnRun(deps.control, { ...o, logFile: path.join(runs, o.runId, 'ui.log') });
    await waitForJournal(runs, o.runId, pid);
    await writePid(runs, o.runId, pid);
    deps.log?.(`run ${o.runId} ${o.mode} pid ${pid}`);
  };
  // The 409 checks read the filesystem, which lags a spawn by up to the journal wait; two concurrent
  // requests would both pass. A key is held from the check to the pid write.
  const launching = new Set<string>();
  const exclusive = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (launching.has(key)) throw new HttpError(409, `${key} is already starting`);
    launching.add(key);
    try {
      return await fn();
    } finally {
      launching.delete(key);
    }
  };
  const P = '/api';
  return [
    { method: 'GET', path: `${P}/projects`, handler: async ({ json }) => json(200, await listProjects(await index())) },
    {
      method: 'POST',
      path: `${P}/projects`,
      handler: async ({ body, json }) => {
        const dir = path.resolve(str(await body(), 'dir'));
        const read = await readProject(dir).catch((err: Error) => {
          throw new HttpError(400, `not a project directory: ${err.message.includes('ENOENT') ? 'docs/project.json is missing' : err.message}`);
        });
        await addProject(dir, deps.home);
        const idx = await index();
        const rows = await listProjects(idx);
        json(200, rows.find((r) => r.dir === dir) ?? { projectId: read.project.projectId, dir, specs: [] });
      },
    },
    {
      method: 'GET',
      path: `${P}/projects/:projectId/runs`,
      handler: async ({ params, json }) => {
        const idx = await index();
        await projectDir(idx, params.projectId!);
        json(200, await listRuns(idx, params.projectId!));
      },
    },
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs/:specId/runs`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const dir = await projectDir(idx, params.projectId!);
        const specId = safe(params.specId!);
        const { specs } = await readProject(dir);
        if (!specs.some((s) => s.specId === specId)) throw new HttpError(404, `unknown spec ${specId}`);
        const runId = await exclusive(`spec ${params.projectId}/${specId}`, async () => {
          const rows = await listRuns(idx, params.projectId!);
          const active = rows.find((r) => r.specId === specId && CLAIMS_SPEC.has(r.status));
          if (active) throw new HttpError(409, `spec ${specId} already has run ${active.runId} (${active.status})`);
          const id = await nextRunId({ runs: runsDir(idx) }, specId);
          await launch(idx, { projectDir: dir, specId, runId: id, mode: 'run' });
          return id;
        });
        json(200, { runId });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/resume`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        await exclusive(`run ${runId}`, async () => {
          const { row, dir } = await findRun(idx, runId);
          if (row.status !== 'paused:auth' && row.status !== 'interrupted') throw new HttpError(409, `run ${runId} is ${row.status}; only paused:auth or interrupted runs resume`);
          await launch(idx, { projectDir: dir, specId: row.specId, runId, mode: 'resume' });
        });
        json(200, { runId });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/stop`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        await findRun(idx, runId);
        const runs = runsDir(idx);
        const pid = await readPid(runs, runId);
        if (pid === null || !isAlive(deps.control, pid)) throw new HttpError(409, `run ${runId} has no live process started from the UI`);
        const how = await stop(deps.control, pid);
        await clearPid(runs, runId);
        json(200, { stopped: true, how: how === 'gone' ? 'terminated' : how });
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const runs = runsDir(idx);
        const evs = await events(runs, runId);
        const startedEv = evs.find((e) => e.type === 'RUN_STARTED');
        const specId = String(startedEv?.data.specId ?? '');
        const projectId = String(startedEv?.data.projectId ?? '');
        const finished = [...evs].reverse().find((e) => e.type === 'RUN_FINISHED') ?? null;
        const state = reduceEvents(evs);
        const spec = await projectDir(idx, projectId)
          .then(readProject)
          .then((p) => p.specs.find((s) => s.specId === specId) ?? null)
          .catch(() => null);
        json(200, {
          runId,
          specId,
          projectId,
          status: finished ? String(finished.data.result) : state.status,
          state: { status: state.status, order: state.order, tasks: state.order.map((id) => state.tasks.get(id)) },
          finished: finished?.data ?? null,
          tokens: tokensOf(evs),
          acceptanceCriteria: spec?.acceptanceCriteria ?? [],
        });
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/events`,
      handler: async ({ req, params, sse }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const runs = runsDir(idx);
        const file = path.join(runs, runId, 'events.ndjson');
        const evs = await events(runs, runId);
        const header = req.headers['last-event-id'];
        const after = Number(Array.isArray(header) ? header[0] : (header ?? 0)) || 0;
        const w = sse();
        let last = after;
        let tail: { close(): void } | null = null;
        const send = (e: StoredEvent) => {
          last = e.seq;
          w.send('journal', e, String(e.seq));
          if (e.type === 'RUN_FINISHED') {
            w.send('end', {});
            tail?.close();
            w.close();
          }
        };
        for (const e of evs) if (e.seq > after) send(e);
        if (evs.some((e) => e.type === 'RUN_FINISHED')) return;
        tail = tailJournal(file, last, send);
        w.onClose(() => tail?.close());
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/steps/:stepId`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const stepId = safe(params.stepId!);
        const dir = path.join(runsDir(idx), runId, 'steps', stepId);
        const prompt = await fs.readFile(path.join(dir, 'prompt.md'), 'utf8').catch(() => null);
        if (prompt === null) throw new HttpError(404, `no step ${stepId} in run ${runId}`);
        const output = await fs
          .readFile(path.join(dir, 'output.json'), 'utf8')
          .then((t) => JSON.parse(t) as unknown)
          .catch(() => null);
        json(200, { prompt, output });
      },
    },
  ];
}
