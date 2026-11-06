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

  it('answers 404 for a well-formed repository name the architecture does not name', async () => {
    const json = vi.fn();
    await expect(handler('/repositories/:repo')({ params: { projectId: 'live-skill', repo: 'teste' }, json } as never)).rejects.toMatchObject({ status: 404 });
  });

  it('answers 400 for a repository name that is not a slug', async () => {
    const json = vi.fn();
    await expect(handler('/repositories/:repo')({ params: { projectId: 'shop', repo: 'Bad_Name' }, json } as never)).rejects.toMatchObject({ status: 400 });
  });

  it('answers the dashboard of a repository with the same checks: 404 for an unknown project, 400 for a bad name', async () => {
    const json = vi.fn();
    await expect(handler('/dashboard')({ params: { projectId: 'shop', repo: 'shop' }, json } as never)).rejects.toMatchObject({ status: 404 });
    await expect(handler('/dashboard')({ params: { projectId: 'shop', repo: 'Bad_Name' }, json } as never)).rejects.toMatchObject({ status: 400 });
    expect(json).not.toHaveBeenCalled();
  });
});

describe('project graph routes', () => {
  const find = (method: string, suffix: string, deps: object = {}) =>
    runRoutes({ cfg: async () => ({ projects: [] }) as never, home: '/tmp/teams-ai-none', control: {} as never, ...deps } as never).find((r) => r.method === method && r.path.endsWith(suffix))!.handler;

  it('answers 404 for the graph of a project the server does not know', async () => {
    await expect(find('GET', '/projects/:projectId/graph')({ params: { projectId: 'shop' }, json: vi.fn() } as never)).rejects.toMatchObject({ status: 404 });
  });

  it('answers no link for a graph file of a project it has no clone of', async () => {
    const json = vi.fn();
    await find('GET', '/graph/file')({ params: { projectId: 'shop' }, query: new URLSearchParams('repo=shop&path=a.ts&line=3'), json } as never);
    expect(json).toHaveBeenCalledWith(200, { url: null });
  });

  it('refuses to build the graph without graphify (501) and for an unknown project (404)', async () => {
    const rebuild = '/graph/rebuild';
    await expect(find('POST', rebuild)({ params: { projectId: 'shop' }, json: vi.fn() } as never)).rejects.toMatchObject({ status: 501 });
    await expect(find('POST', rebuild, { graphify: {} })({ params: { projectId: 'shop' }, json: vi.fn() } as never)).rejects.toMatchObject({ status: 404 });
  });
});
