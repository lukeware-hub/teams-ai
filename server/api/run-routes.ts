import path from 'node:path';
import type { Config } from '../config/config.js';
import { addProject } from '../onboarding/config-store.js';
import { isAlive, type RunControlDeps } from './run-control.js';
import { listProjects, listRuns, readProject, type IndexDeps } from './run-index.js';
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
  ];
}
