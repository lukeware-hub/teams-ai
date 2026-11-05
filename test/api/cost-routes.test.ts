import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costRoutes } from '../../server/api/cost-routes.js';
import { startApi } from '../../server/api/server.js';
import type { CostFact } from '../../server/usage/cost-types.js';
import type { CostScan, CostScanner } from '../../server/usage/cost-scan.js';

const now = new Date(2026, 10, 5, 15, 0);
const fact = (over: Partial<CostFact> & Pick<CostFact, 'stage' | 'costUsd'>): CostFact => ({
  projectId: 'shop',
  specId: 'checkout',
  runId: 'shop--checkout--run-1',
  repository: 'shop-api',
  taskId: null,
  attempt: 0,
  phase: 'phase3',
  kind: 'dev',
  role: 'dev',
  provider: 'claude',
  model: 'sonnet',
  at: new Date(2026, 10, 5, 9, 0).toISOString(),
  tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...over,
});

const scan: CostScan = {
  projects: [{ projectId: 'shop', name: 'Loja' }, { projectId: 'empty', name: 'Vazio' }],
  unreadJournals: 1,
  facts: [
    fact({ stage: 'development', costUsd: 2 }),
    fact({ stage: 'development', costUsd: 1, role: 'test', kind: 'test', phase: 'phase4' }),
    fact({ stage: 'refinement', costUsd: 0.5, specId: 'checkout', runId: null, repository: null, role: 'po', kind: 'spec', phase: 'refine' }),
    fact({ stage: 'chat', costUsd: 0.1, specId: null, runId: null, repository: null, role: 'po', kind: 'resposta', phase: 'chat', model: 'haiku' }),
  ],
};
const scanner: CostScanner = { scan: async () => scan };

let api: { port: number; close(): Promise<void> };
const url = (path: string) => `http://127.0.0.1:${api.port}${path}`;

beforeEach(async () => {
  api = await startApi({ routes: costRoutes({ scanner, jevLedgerUsd: async () => 0, now: () => now }) }, 0);
});
afterEach(async () => {
  await api.close();
});

describe('cost routes', () => {
  it('answers the whole-installation view with the stages apart and the unread journals', async () => {
    const res = await fetch(url('/api/costs?period=tudo'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byStage.development.costUsd).toBe(3);
    expect(body.byStage.refinement.costUsd).toBe(0.5);
    expect(body.byStage.chat.costUsd).toBe(0.1);
    expect(body.unreadJournals).toBe(1);
    expect(body.projects.map((p: { projectId: string }) => p.projectId)).toEqual(['shop', 'empty']);
  });

  it('refuses an unknown period', async () => {
    const res = await fetch(url('/api/costs?period=mes'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining('period must be one of') });
  });

  it('answers one project with refinement and development as separate totals', async () => {
    const res = await fetch(url('/api/costs/projects/shop?period=tudo'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Loja');
    expect(body.refinement.total.costUsd).toBe(0.5);
    expect(body.development.total.costUsd).toBe(3);
    expect(body.chat.costUsd).toBe(0.1);
    expect(body.specs.map((s: { key: string }) => s.key)).toEqual(['checkout']);
  });

  it('answers 404 for a project that is not registered and 400 for a malformed id', async () => {
    expect((await fetch(url('/api/costs/projects/nao-existe'))).status).toBe(404);
    expect((await fetch(url('/api/costs/projects/Bad%20Id!'))).status).toBe(400);
  });

  it('pages the steps of a project and filters them by agent', async () => {
    const res = await fetch(url('/api/costs/projects/shop/steps/page?period=tudo&agente=test&size=5'));
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.matched).toBe(1);
    expect(page.list.map((r: CostFact) => [r.role, r.costUsd])).toEqual([['test', 1]]);
  });
});
