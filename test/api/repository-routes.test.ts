import { describe, expect, it, vi } from 'vitest';
import { runRoutes } from '../../server/api/run-routes.js';

/** The two repository read routes, called directly with a config that has no projects. */
const routes = runRoutes({ cfg: async () => ({ projects: [] }) as never, home: '/tmp/teams-ai-none', control: {} as never } as never);
const handler = (suffix: string) => routes.find((r) => r.method === 'GET' && r.path.endsWith(suffix))!.handler;

describe('repository read routes', () => {
  it('answers 404 for a project the server does not know', async () => {
    const json = vi.fn();
    await expect(handler('/repositories')({ params: { projectId: 'shop' }, json } as never)).rejects.toMatchObject({ status: 404 });
    expect(json).not.toHaveBeenCalled();
  });

  it('answers 400 for a repository name that is neither a service name nor the project', async () => {
    const json = vi.fn();
    await expect(handler('/repositories/:repo')({ params: { projectId: 'shop', repo: 'Bad_Name' }, json } as never)).rejects.toMatchObject({ status: 400 });
  });
});
