import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { addProject } from '../onboarding/config-store.js';
import { nextRunId } from '../orchestrator/workspace.js';
import { loadEvents } from '../store/event-store.js';
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
  const findRun = async (idx: IndexDeps, runId: string): Promise<{ row: RunRow; dir: string }> => {
    const runs = runsDir(idx);
    const file = path.join(runs, runId, 'events.ndjson');
    await fs.access(file).catch(() => {
      throw new HttpError(404, `unknown run ${runId}`);
    });
    const events = await loadEvents(file);
    const projectId = String(events.find((e) => e.type === 'RUN_STARTED')?.data.projectId ?? '');
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
        const rows = await listRuns(idx, params.projectId!);
        const active = rows.find((r) => r.specId === specId && CLAIMS_SPEC.has(r.status));
        if (active) throw new HttpError(409, `spec ${specId} already has run ${active.runId} (${active.status})`);
        const runId = await nextRunId({ runs: runsDir(idx) }, specId);
        await launch(idx, { projectDir: dir, specId, runId, mode: 'run' });
        json(200, { runId });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/resume`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const { row, dir } = await findRun(idx, runId);
        if (row.status !== 'paused:auth' && row.status !== 'interrupted') throw new HttpError(409, `run ${runId} is ${row.status}; only paused:auth or interrupted runs resume`);
        await launch(idx, { projectDir: dir, specId: row.specId, runId, mode: 'resume' });
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
  ];
}
