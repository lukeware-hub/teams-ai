import { describe, expect, it, vi } from 'vitest';
import { resolveClosing } from '../../server/refine/closing-resolver.js';
import type { RefineSession } from '../../server/refine/session.js';
import { closingChecks, emptyRefineState, type RefineState } from '../../server/refine/state.js';

const valid = { requestId: 'pedido-1', summary: 'O pedido acrescenta a exportação.', affected: [], conflicts: [], duplicates: [], dependencies: [], risks: [] };
const request = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar em PDF.', at: '2026-11-04T10:00:00.000Z' };

describe('the request impact is measured again when it is missing or stale', () => {
  it('a closing round that fails the impact check evaluates again, so the impact step runs once more', async () => {
    const s = {
      state: { reviewClosed: true, architecture: { decision: {} }, staleBy: {}, patches: [], repositories: false },
      closingSummary: vi.fn(async () => ({ ok: false, checks: [{ id: 'impact', ok: false, detail: 'o impacto do pedido ainda não foi analisado' }], summaryHash: 'h' })),
      evaluate: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
      isArchitectureStale: vi.fn(async () => false),
      decideArchitecture: vi.fn(async () => undefined),
      runPlans: vi.fn(async () => undefined),
      evaluateStage: vi.fn(async () => undefined),
      addToGraph: vi.fn(async () => undefined),
      accept: vi.fn(async () => undefined),
    };
    await resolveClosing(s as unknown as RefineSession);
    expect(s.evaluate).toHaveBeenCalled();
  });

  it('an impact made on an outline the backlog has since moved past is stale and fails the check', () => {
    const state = { ...emptyRefineState(), extension: request, impact: { inputHash: 'h', impact: valid, issues: [], cycle: 1, backlogCycle: 1 }, backlog: { enabled: true, project: null, epics: [], items: [], cycle: 2 } } as unknown as RefineState;
    const check = closingChecks(state, true).find((c) => c.id === 'impact');
    expect(check).toMatchObject({ ok: false, detail: expect.stringContaining('para trás') });
  });

  it('an impact made on the current outline passes the check', () => {
    const state = { ...emptyRefineState(), extension: request, impact: { inputHash: 'h', impact: valid, issues: [], cycle: 2, backlogCycle: 2 }, backlog: { enabled: true, project: null, epics: [], items: [], cycle: 2 } } as unknown as RefineState;
    expect(closingChecks(state, true).find((c) => c.id === 'impact')).toMatchObject({ ok: true });
  });

  it('a later run that only detailed the same outline keeps the impact current', () => {
    const state = { ...emptyRefineState(), extension: request, impact: { inputHash: 'h', impact: valid, issues: [], cycle: 9, backlogCycle: 2 }, backlog: { enabled: true, project: null, epics: [], items: [], cycle: 2 } } as unknown as RefineState;
    expect(closingChecks(state, true).find((c) => c.id === 'impact')).toMatchObject({ ok: true });
  });
});
