import { afterEach, describe, expect, it } from 'vitest';
import { matchRoute, startApi, type Route } from '../../server/api/server.js';

const routes: Route[] = [
  { method: 'GET', path: '/api/runs/:runId', handler: async ({ json, params }) => json(200, { runId: params.runId }) },
  { method: 'GET', path: '/api/runs/:runId/steps/:stepId', handler: async ({ json, params }) => json(200, params) },
  { method: 'GET', path: '/api/runs', handler: async ({ json }) => json(200, []) },
];

let api: { port: number; close(): Promise<void> } | null = null;
afterEach(async () => {
  await api?.close();
  api = null;
});

describe('route parameters', () => {
  it('matches literal and :param segments and decodes them', () => {
    expect(matchRoute(routes, 'GET', '/api/runs')!.params).toEqual({});
    expect(matchRoute(routes, 'GET', '/api/runs/spec-001-r1')!.params).toEqual({ runId: 'spec-001-r1' });
    expect(matchRoute(routes, 'GET', '/api/runs/a%20b/steps/s00001')!.params).toEqual({ runId: 'a b', stepId: 's00001' });
    expect(matchRoute(routes, 'GET', '/api/runs/x/steps')).toBeNull();
    expect(matchRoute(routes, 'POST', '/api/runs/x')).toBeNull();
  });
  it('hands params to the handler over HTTP', async () => {
    api = await startApi({ routes }, 0);
    const r = await fetch(`http://127.0.0.1:${api.port}/api/runs/spec-001-r1/steps/s00002`);
    expect(await r.json()).toEqual({ runId: 'spec-001-r1', stepId: 's00002' });
  });
});
