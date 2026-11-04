import { describe, expect, it } from 'vitest';
import { requestTrace } from '../../server/refine/trace.js';
import { emptyRefineState, type RefineState } from '../../server/refine/state.js';

const item = (key: string, rank: number, sources: Array<{ doc: string; heading: string }>) => ({ key, title: key, epic: 'core', scope: 's', priority: 'P1', rationale: 'r', dependsOn: [], sources, size: 'M', rank });

describe('requestTrace', () => {
  it('names the specs that cite the request section, and which of them have a plan and a task list', () => {
    const state = {
      ...emptyRefineState(),
      extension: { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar em PDF.', at: 'x' },
      backlog: { enabled: true, project: null, epics: [{ key: 'core', title: 'Core' }], items: [item('login', 1, [{ doc: 'flow.md', heading: '1. Login' }]), item('export', 2, [{ doc: 'briefing.md', heading: 'Pedido pedido-1' }])], cycle: 1, keyIds: true },
      speckit: { status: 'done', stale: false, inputHash: 'h', steps: [{ command: 'plan', itemKey: 'export', basis: 'b' }, { command: 'tasks', itemKey: 'export', basis: 'b' }] },
    } as never as RefineState;
    expect(requestTrace(state)).toEqual({
      heading: 'Pedido pedido-1',
      specs: [
        { key: 'login', specId: 'login', citesRequest: false, planned: false, tasked: false, verdict: 'pending' },
        { key: 'export', specId: 'export', citesRequest: true, planned: true, tasked: true, verdict: 'ok' },
      ],
    });
  });

  it('gives a spec whose plan failed the verdict failed, and a spec still waiting the verdict pending', () => {
    const state = {
      ...emptyRefineState(),
      extension: { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar em PDF.', at: 'x' },
      backlog: { enabled: true, project: null, epics: [{ key: 'core', title: 'Core' }], items: [item('login', 1, []), item('export', 2, [{ doc: 'briefing.md', heading: 'Pedido pedido-1' }])], cycle: 1, keyIds: true },
      speckit: { status: 'failed', stale: false, steps: [], failures: [{ command: 'plan', itemKey: 'export', kind: 'agent', reason: 'r', detail: 'd' }] },
    } as never as RefineState;
    expect(requestTrace(state)?.specs.map((s) => [s.key, s.verdict])).toEqual([['login', 'pending'], ['export', 'failed']]);
  });

  it('is absent for a session that is not a request', () => {
    expect(requestTrace(emptyRefineState())).toBeNull();
  });
});
