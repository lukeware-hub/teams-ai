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
    const routes = refineRoutes({ registry: { get: vi.fn(async () => ({ continueStage })) } as never, log: vi.fn() });
    const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/stage/continue'))!;
    const json = vi.fn();
    await route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, body: async () => ({ doc: 'briefing.md' }), json } as never);
    expect(continueStage).toHaveBeenCalledWith('briefing.md');
    await expect(route.handler({ params: { projectId: 'shop', specId: 'shop-002' }, body: async () => ({ doc: 'brief.md' }), json } as never)).rejects.toMatchObject({ status: 400 });
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
});
