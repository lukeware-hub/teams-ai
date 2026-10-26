import { describe, expect, it, vi } from 'vitest';
import { RefineEvent, type Question } from '../../server/refine/events.js';
import { makeAnswerer } from '../../server/refine/speckit-answers.js';
import type { SpeckitInput } from '../../server/refine/speckit-pack.js';

const DOCS = { 'project.md': '# Projeto', 'flow.md': '', 'briefing.md': '## Regras', 'stack.md': '', 'design.md': '', 'specs.md': '' } as Record<SpeckitInput, string>;
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const summary = { usage, costUsd: 0, durationMs: 1, numTurns: 1, rateLimit: null };
const card = { subject: 'Prazo', context: 'Item Entrar. Sem prazo, o link fica aberto.', text: 'Por quanto tempo vale o link?', options: [] };
const question: Question = { questionId: 'speckit-1', role: 'po', text: 'Qual o prazo do link?', blocking: true, relatedAcIds: [], cycle: 1, origin: 'speckit', itemKey: 'login' };
const draft = { root: '/w/refine/hello-001', steps: (seq: number) => `/w/refine/hello-001/steps/${seq}` };

type Req = { kind: string; role: string; pack: { feedback?: string }; extraAllow?: string[] };

/** The documents leave the question open with a card; the web search answers as `search` says. */
function harness(research: boolean, search: (req: Req) => unknown) {
  const fact = vi.fn(async (_type: string, _data: object) => undefined);
  const runAgent = vi.fn(async (req: Req, _ctx: unknown) => {
    if (req.kind === 'speckit-research') return search(req);
    return { ok: true, value: { specHash: 'h', results: [{ questionId: 'speckit-1', answer: null, evidence: [], card }] }, summary };
  });
  const answerer = makeAnswerer({ draft, journal: { allocStepSeq: () => 1, fact } as never, runAgent: runAgent as never, texts: DOCS, hash: 'h', titles: new Map([['login', 'Entrar']]), stagingDir: '/w/refine/hello-001/speckit', research });
  return { answerer, fact, runAgent };
}

describe('the web search for the questions the documents leave open', () => {
  it('adds the suggestion as one more option when the search returned the address it cites', async () => {
    const { answerer, fact } = harness(true, () => ({ ok: true, value: { specHash: 'h', results: [{ questionId: 'speckit-1', suggestion: { label: '30 dias', detail: 'O guia diz 30 dias.', url: 'https://example.com/prazo' } }] }, summary: { ...summary, webSearchUrls: ['https://example.com/prazo'] } }));
    await answerer.triage([question]);
    expect(fact).toHaveBeenCalledWith(RefineEvent.SpeckitTriaged, {
      results: [expect.objectContaining({ questionId: 'speckit-1', text: 'Por quanto tempo vale o link?', options: [{ label: '30 dias', detail: 'Pesquisa na internet: O guia diz 30 dias. Fonte: https://example.com/prazo' }] })],
    });
    expect((fact.mock.calls[0]![1] as { results: Array<{ answer?: unknown }> }).results[0]!.answer).toBeUndefined();
  });

  it('drops a suggestion whose address the search did not return', async () => {
    const { answerer, fact } = harness(true, () => ({ ok: true, value: { specHash: 'h', results: [{ questionId: 'speckit-1', suggestion: { label: '30 dias', detail: 'Inventado.', url: 'https://example.com/inventado' } }] }, summary: { ...summary, webSearchUrls: ['https://example.com/prazo'] } }));
    await answerer.triage([question]);
    expect(fact.mock.calls[0]![1]).toMatchObject({ results: [{ questionId: 'speckit-1', options: [] }] });
  });

  it('does not search when the setting is off', async () => {
    const { answerer, runAgent } = harness(false, () => {
      throw new Error('no search expected');
    });
    await answerer.triage([question]);
    expect(runAgent.mock.calls.map(([req]) => req.kind)).toEqual(['speckit-answer']);
  });

  it('keeps the card when the search fails', async () => {
    const { answerer, fact } = harness(true, () => ({ ok: false, failure: 'quota', errors: ['quota'], summary }));
    await answerer.triage([question]);
    expect(fact.mock.calls[0]![1]).toMatchObject({ results: [{ questionId: 'speckit-1', text: 'Por quanto tempo vale o link?', options: [] }] });
  });

  it('asks the search with the question and its item only, with WebSearch as the one tool allowed', async () => {
    const { answerer, runAgent } = harness(true, () => ({ ok: true, value: { specHash: 'h', results: [] }, summary: { ...summary, webSearchUrls: [] } }));
    await answerer.triage([question]);
    const [req] = runAgent.mock.calls.find(([r]) => r.kind === 'speckit-research')!;
    expect(req.extraAllow).toEqual(['WebSearch']);
    expect(req.pack.feedback).toContain('Qual o prazo do link?');
    expect(req.pack.feedback).toContain('(item: Entrar)');
    expect(req.pack.feedback).not.toContain('### project.md');
  });
});
