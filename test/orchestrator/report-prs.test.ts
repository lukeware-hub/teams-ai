import { describe, expect, it } from 'vitest';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { runPrs } from '../../server/orchestrator/phases/report.js';

describe('report pull requests', () => {
  it('lists every pull request of the run once, with its task, its repository and whether it merged', () => {
    const opened = (branch: string, url: string, created = true) => ({ type: OrchEvent.PrCreated, data: { branch, number: Number(url.split('/').pop()), url, created } });
    const events = [
      opened('docs/cancelar-pedido-plan', 'https://github.com/o/loja-eventos/pull/7'),
      { type: OrchEvent.DocsMerged, data: { phase: 2, pr: 7, branch: 'docs/cancelar-pedido-plan' } },
      opened('task/cancelar-pedido-T1-add-order-cancel', 'https://github.com/o/loja-eventos-pedidos/pull/9'),
      opened('task/cancelar-pedido-T5-document-cancel-event', 'https://github.com/o/loja-eventos-estoque/pull/9'),
      // A resumed run opens the same pull request again.
      opened('task/cancelar-pedido-T1-add-order-cancel', 'https://github.com/o/loja-eventos-pedidos/pull/9', false),
      { type: OrchEvent.PrMerged, data: { taskId: 'T1-add-order-cancel', pr: 9 } },
    ];
    expect(runPrs(events, 'cancelar-pedido')).toEqual([
      { task: null, branch: 'docs/cancelar-pedido-plan', number: 7, url: 'https://github.com/o/loja-eventos/pull/7', repository: 'o/loja-eventos', merged: true },
      { task: 'T1-add-order-cancel', branch: 'task/cancelar-pedido-T1-add-order-cancel', number: 9, url: 'https://github.com/o/loja-eventos-pedidos/pull/9', repository: 'o/loja-eventos-pedidos', merged: true },
      // Same number in another repository: another pull request, and this one never merged.
      { task: 'T5-document-cancel-event', branch: 'task/cancelar-pedido-T5-document-cancel-event', number: 9, url: 'https://github.com/o/loja-eventos-estoque/pull/9', repository: 'o/loja-eventos-estoque', merged: false },
    ]);
  });
});
