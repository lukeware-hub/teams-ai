import { describe, expect, it } from 'vitest';
import { inPeriod, money, overview, projectCosts, specLabel } from '../../server/usage/cost-report.js';
import type { CostFact } from '../../server/usage/cost-types.js';

const now = new Date(2026, 10, 5, 15, 0); // local time: 5 Nov 2026, 15:00
const at = (d: Date) => d.toISOString();
const days = (n: number) => new Date(now.getTime() - n * 86_400_000);

const fact = (over: Partial<CostFact> & Pick<CostFact, 'stage' | 'at' | 'costUsd'>): CostFact => ({
  projectId: 'shop',
  specId: 'checkout',
  runId: null,
  repository: null,
  taskId: null,
  attempt: 0,
  phase: 'phase3',
  kind: 'dev',
  role: 'dev',
  provider: 'claude',
  model: 'sonnet',
  tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 999, cacheWriteTokens: 999 },
  ...over,
});

describe('inPeriod', () => {
  it('hoje starts at the local midnight of the server day', () => {
    expect(inPeriod(fact({ stage: 'development', at: at(new Date(2026, 10, 5, 0, 0)), costUsd: 1 }), 'hoje', now)).toBe(true);
    expect(inPeriod(fact({ stage: 'development', at: at(new Date(2026, 10, 4, 23, 59)), costUsd: 1 }), 'hoje', now)).toBe(false);
  });

  it('7d and 30d count back from now, and tudo has no bound', () => {
    const inside7 = fact({ stage: 'development', at: at(days(6.9)), costUsd: 1 });
    const outside7 = fact({ stage: 'development', at: at(days(7.1)), costUsd: 1 });
    const outside30 = fact({ stage: 'development', at: at(days(30.1)), costUsd: 1 });
    expect([inPeriod(inside7, '7d', now), inPeriod(outside7, '7d', now)]).toEqual([true, false]);
    expect(inPeriod(outside7, '30d', now)).toBe(true);
    expect(inPeriod(outside30, '30d', now)).toBe(false);
    expect(inPeriod(outside30, 'tudo', now)).toBe(true);
  });
});

describe('money', () => {
  it('sums cost and input plus output tokens, and counts calls with no cost apart', () => {
    const total = money([
      fact({ stage: 'development', at: at(now), costUsd: 0.1 }),
      fact({ stage: 'development', at: at(now), costUsd: 0.2 }),
      fact({ stage: 'development', at: at(now), costUsd: null }),
    ]);
    expect(total).toEqual({ costUsd: 0.3, tokens: 450, steps: 3, semCusto: 1 });
  });
});

describe('specLabel', () => {
  it('names the backlog and follow-on drafts, and keeps a spec id as it is', () => {
    expect(specLabel('shop-backlog')).toBe('Backlog do projeto');
    expect(specLabel('shop-pedido-2')).toBe('Pedido 2');
    expect(specLabel('checkout')).toBe('checkout');
  });
});

describe('overview', () => {
  const facts: CostFact[] = [
    fact({ stage: 'refinement', at: at(now), costUsd: 1, specId: 'checkout', role: 'po', phase: 'refine', kind: 'spec' }),
    fact({ stage: 'development', at: at(now), costUsd: 3, runId: 'shop--checkout--run-1', repository: 'shop-api', role: 'dev' }),
    fact({ stage: 'chat', at: at(now), costUsd: 0.5, specId: null, role: 'po', kind: 'resposta', model: 'haiku', phase: 'chat' }),
    fact({ stage: 'development', at: at(now), costUsd: 2, provider: 'openrouter', role: null, kind: 'decisao-jev', model: 'jev-model', phase: 'decisao' }),
    fact({ stage: 'refinement', at: at(days(40)), costUsd: 9, specId: 'old', role: 'sm', phase: 'refine' }),
  ];
  const projects = [{ projectId: 'shop', name: 'Loja' }, { projectId: 'empty', name: 'Vazio' }];

  it('keeps refinement, development and chat apart and totals them without mixing', () => {
    const o = overview({ facts, projects, period: '30d', now, unreadJournals: 0, jevLedgerUsd: null });
    expect(o.byStage.refinement.costUsd).toBe(1);
    expect(o.byStage.development.costUsd).toBe(5);
    expect(o.byStage.chat.costUsd).toBe(0.5);
    expect(o.total.costUsd).toBe(6.5);
  });

  it('lists every registered project, including one with no spend, sorted by total', () => {
    const o = overview({ facts, projects, period: 'tudo', now, unreadJournals: 0, jevLedgerUsd: null });
    expect(o.projects.map((p) => [p.projectId, p.total.costUsd, p.runs])).toEqual([
      ['shop', 15.5, 1],
      ['empty', 0, 0],
    ]);
  });

  it('names the agent of a decision call by its provider when it has no role', () => {
    const o = overview({ facts, projects, period: 'tudo', now, unreadJournals: 0, jevLedgerUsd: null });
    expect(o.agents.map((a) => [a.stage, a.key, a.costUsd])).toEqual([
      ['refinement', 'sm', 9],
      ['development', 'dev', 3],
      ['development', 'jev', 2],
      ['refinement', 'po', 1],
      ['chat', 'po', 0.5],
    ]);
  });

  it('gives the Jev cost outside the projects only for the whole history, as the ledger minus the journals', () => {
    expect(overview({ facts, projects, period: 'tudo', now, unreadJournals: 0, jevLedgerUsd: 5 }).jevUnassignedUsd).toBe(3);
    expect(overview({ facts, projects, period: 'hoje', now, unreadJournals: 0, jevLedgerUsd: 5 }).jevUnassignedUsd).toBeNull();
    expect(overview({ facts, projects, period: 'tudo', now, unreadJournals: 0, jevLedgerUsd: 1 }).jevUnassignedUsd).toBe(0);
  });

  it('counts the period filter on every total', () => {
    const o = overview({ facts, projects, period: '30d', now, unreadJournals: 2, jevLedgerUsd: null });
    expect(o.total.costUsd).toBe(6.5);
    expect(o.unreadJournals).toBe(2);
  });
});

describe('projectCosts', () => {
  const facts: CostFact[] = [
    fact({ stage: 'refinement', at: at(now), costUsd: 1, specId: 'checkout', role: 'po', phase: 'refine', kind: 'spec', repository: 'shop-api' }),
    fact({ stage: 'refinement', at: at(now), costUsd: 0.5, specId: 'shop-backlog', role: 'sm', phase: 'refine', kind: 'backlog' }),
    fact({ stage: 'development', at: at(now), costUsd: 2, specId: 'checkout', runId: 'shop--checkout--run-1', repository: 'shop-api', role: 'dev', phase: 'phase3', kind: 'dev' }),
    fact({ stage: 'development', at: at(now), costUsd: 1, specId: 'checkout', runId: 'shop--checkout--run-1', repository: 'shop-web', role: 'test', phase: 'phase4', kind: 'test' }),
    fact({ stage: 'development', at: at(now), costUsd: 0.25, specId: 'checkout', runId: 'shop--checkout--complete-run-1', repository: null, role: 'sm', phase: 'phase6', kind: 'report' }),
    fact({ stage: 'chat', at: at(now), costUsd: 0.1, specId: null, role: 'po', phase: 'chat', kind: 'resposta', model: 'haiku' }),
  ];

  it('gives refinement and development their own totals, breakdowns and repository split', () => {
    const p = projectCosts({ facts, projectId: 'shop', name: 'Loja', period: 'tudo', now, unreadJournals: 0 });
    expect(p.refinement.total.costUsd).toBe(1.5);
    expect(p.development.total.costUsd).toBe(3.25);
    expect(p.chat.costUsd).toBe(0.1);
    expect(p.development.byRepository.map((r) => [r.key, r.costUsd])).toEqual([
      ['shop-api', 2],
      ['shop-web', 1],
      ['sem repositório', 0.25],
    ]);
    expect(p.development.byPhase.map((r) => r.key)).toEqual(['phase3', 'phase4', 'phase6']);
    expect(p.refinement.byAgent.map((r) => r.key)).toEqual(['po', 'sm']);
  });

  it('lists each spec once with its refinement and development cost and its distinct runs', () => {
    const p = projectCosts({ facts, projectId: 'shop', name: 'Loja', period: 'tudo', now, unreadJournals: 0 });
    const checkout = p.specs.find((s) => s.key === 'checkout')!;
    expect(checkout).toEqual(expect.objectContaining({ label: 'checkout', refinement: 1, development: 3.25, total: 4.25, runs: 2 }));
    expect(p.specs.find((s) => s.key === 'shop-backlog')).toEqual(expect.objectContaining({ label: 'Backlog do projeto', refinement: 0.5, development: 0 }));
  });
});
