import { describe, expect, it, vi } from 'vitest';
import { refineRoutes } from '../../server/api/refine-routes.js';
import { ConflictError } from '../../server/refine/session.js';

describe('refine routes', () => {
  it('reprocesses the named document from its passed text, and refuses a name outside the five', async () => {
    const reprocessStage = vi.fn(() => Promise.resolve());
    const routes = refineRoutes({ registry: { get: vi.fn(async () => ({ reprocessStage })) } as never, log: vi.fn() });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/docs/:file/reprocess'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002', file: 'stack.md' }, json } as never);
    expect(reprocessStage).toHaveBeenCalledWith('stack.md');
    expect(json).toHaveBeenCalledWith(202, { ok: true });
    await expect(route.handler({ params: { projectId: 'shop', specId: 'shop-002', file: 'brief.md' }, json } as never)).rejects.toMatchObject({ status: 400 });
  });

  it('continues the document named in the body, and refuses a name outside the five', async () => {
    const continueStage = vi.fn(async () => undefined);
    const routes = refineRoutes({ registry: { get: vi.fn(async () => ({ continueStage, state: {} })) } as never, log: vi.fn() });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/stage/continue'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, body: async () => ({ doc: 'briefing.md' }), json } as never);
    expect(continueStage).toHaveBeenCalledWith('briefing.md', false);
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, body: async () => ({ doc: 'briefing.md', confirmLowScore: true }), json } as never);
    expect(continueStage).toHaveBeenLastCalledWith('briefing.md', true);
    await expect(route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, body: async () => ({ doc: 'brief.md' }), json } as never)).rejects.toMatchObject({ status: 400 });
  });

  it('answers 202 once a repository session has started the extraction of the stage', async () => {
    const continueStage = vi.fn(async () => undefined);
    const routes = refineRoutes({ registry: { get: vi.fn(async () => ({ continueStage, state: { repositories: true } })) } as never, log: vi.fn() });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/stage/continue'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, body: async () => ({ doc: 'flow.md' }), json } as never);
    expect(json).toHaveBeenCalledWith(202, { ok: true });
  });

  it('adds the document named in the body to the graph, answers 202, and refuses a name outside the five', async () => {
    const addToGraph = vi.fn(async () => undefined);
    const routes = refineRoutes({ registry: { get: vi.fn(async () => ({ addToGraph, state: {} })) } as never, log: vi.fn() });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/graph/add'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, body: async () => ({ doc: 'stack.md' }), json } as never);
    expect(addToGraph).toHaveBeenCalledWith('stack.md');
    expect(json).toHaveBeenCalledWith(202, { ok: true });
    await expect(route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, body: async () => ({ doc: 'brief.md' }), json } as never)).rejects.toMatchObject({ status: 400 });
  });

  it('decides the architecture in the background and answers 202', async () => {
    const decideArchitecture = vi.fn(async () => undefined);
    const routes = refineRoutes({ registry: { get: vi.fn(async () => ({ decideArchitecture })) } as never, log: vi.fn() });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/architecture'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, json } as never);
    expect(decideArchitecture).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith(202, { ok: true });
  });

  it('closes the final review of a refinement', async () => {
    const closeReview = vi.fn(async () => undefined);
    const routes = refineRoutes({ registry: { get: vi.fn(async () => ({ closeReview })) } as never, log: vi.fn() });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/review/close'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, json } as never);
    expect(closeReview).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(200, { ok: true });
  });

  it('starts the plan preparation in the background with 202, and a refusal is 409', async () => {
    const log = vi.fn();
    const runPlans = vi.fn(() => Promise.reject(new Error('journal down')));
    const routes = refineRoutes({ registry: { get: vi.fn(async () => ({ runPlans })) } as never, log });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/plans'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, json } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(json).toHaveBeenCalledWith(202, { ok: true });
    expect(log).toHaveBeenCalledWith('refine shop/shop-002: journal down');
    const refused = refineRoutes({ registry: { get: vi.fn(async () => ({ runPlans: () => { throw new ConflictError('evaluation in progress'); } })) } as never });
    await expect(refused.find((r) => r.path.endsWith('/plans'))!.handler({ params: { projectId: 'shop', specId: 'shop-002' }, json } as never)).rejects.toMatchObject({ status: 409 });
  });

  it('a stage review that fails after its answer is logged, and the answer stays 202', async () => {
    const log = vi.fn();
    const session = { evaluateStage: vi.fn(() => Promise.reject(new Error('journal down'))) };
    const routes = refineRoutes({ registry: { get: vi.fn(async () => session) } as never, log });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/docs/:file/evaluate'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002', file: 'flow.md' }, json } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(json).toHaveBeenCalledWith(202, { ok: true });
    expect(log).toHaveBeenCalledWith('refine shop/shop-002: journal down');
  });

  it('answers a request with its session and its mode: backlog for a follow-on, single for a request taken as one spec', async () => {
    const follow = { state: { extension: { requestId: 'pedido-1' } }, snapshot: async () => ({ projectId: 'shop', specId: 'shop-pedido-1' }) };
    const single = { state: {}, snapshot: async () => ({ projectId: 'shop', specId: 'shop-001' }) };
    const addRequest = vi.fn().mockResolvedValueOnce(follow).mockResolvedValueOnce(single);
    const routes = refineRoutes({ registry: { addRequest } as never, log: vi.fn() });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/projects/:projectId/requests'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop' }, body: async () => ({ description: 'Exportar em PDF.' }), json } as never);
    expect(json).toHaveBeenLastCalledWith(200, expect.objectContaining({ mode: 'backlog', specId: 'shop-pedido-1' }));
    await route.handler({ params: { projectId: 'shop' }, body: async () => ({ description: 'Exportar.' }), json } as never);
    expect(json).toHaveBeenLastCalledWith(200, expect.objectContaining({ mode: 'single', specId: 'shop-001' }));
  });
});
