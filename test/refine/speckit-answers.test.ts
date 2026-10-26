import { describe, expect, it, vi } from 'vitest';
import { type Question, RefineEvent } from '../../server/refine/events.js';
import { answererOf, makeAnswerer, speckitAnswerPack, verifyEvidence } from '../../server/refine/speckit-answers.js';
import type { SpeckitInput } from '../../server/refine/speckit-pack.js';

const BRIEF = [
  '# Briefing',
  '',
  '## Regras',
  '',
  'O link de recuperação de senha vale por 90 dias depois do envio.',
  'O sistema não enviará e-mails de cobrança aos clientes ativos ao fim do mês.',
  '',
  '## Decisões',
  '',
  '### Prazo',
  '',
  'O prazo de recuperação vale por trinta dias corridos para todos os clientes.',
].join('\n');
const DOCS = { 'project.md': '# Projeto\n\nVisão do produto.', 'flow.md': '', 'briefing.md': BRIEF, 'stack.md': '', 'design.md': '', 'specs.md': '' } as Record<SpeckitInput, string>;
const LINK = 'O link de recuperação de senha vale por 90 dias depois do envio.';
const summary = { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, durationMs: 1, numTurns: 1, rateLimit: null };
const okOf = (value: object) => ({ ok: true, value: { specHash: 'sha256:x', results: [], ...value }, summary });
const failOf = (failure: string) => ({ ok: false, failure, errors: [failure], summary });
const card = (text: string) => ({ subject: 'Prazo do link', context: 'Item Entrar. Sem prazo, o link fica aberto.', text, options: [] });
const question = (questionId: string, role: 'po' | 'sm' = 'po'): Question => ({ questionId, role, text: `Pergunta ${questionId}?`, blocking: true, relatedAcIds: [], cycle: 1, origin: 'speckit', itemKey: 'login' });
const draft = { root: '/w/refine/hello-001', steps: (seq: number) => `/w/refine/hello-001/steps/${seq}` };
const stagingDir = '/w/refine/hello-001/speckit';

type Req = { kind: string; role: string; cwd: string; denyRead?: string[]; pack: { feedback?: string } };

/** An answerer whose agent calls get `reply`; the journal keeps every fact it is given. */
function harness(reply: (req: Req) => unknown) {
  const fact = vi.fn(async (_type: string, _data: object) => undefined);
  const runAgent = vi.fn(async (req: Req, _ctx: unknown) => reply(req));
  const answerer = makeAnswerer({ draft, journal: { allocStepSeq: () => 1, fact } as never, runAgent: runAgent as never, texts: DOCS, hash: 'h', titles: new Map([['login', 'Entrar']]), stagingDir });
  return { answerer, fact, runAgent };
}

describe('the choices of questions that already have a card', () => {
  it('journals the choices, keeps the card as it is, and never journals an answer', async () => {
    const q = { ...question('speckit-1'), subject: 'Prazo do link', context: 'Item Entrar. Sem prazo, o link fica aberto.' } as Question;
    const choices = [{ label: 'Sim', detail: 'Usa o prazo de 90 dias.', recommended: true }, { label: 'Não', detail: 'Mantém o link aberto.' }];
    const { answerer, fact } = harness(() => okOf({ results: [{ questionId: 'speckit-1', answer: '90 dias', evidence: [{ source: 'briefing.md', quote: LINK }], card: { ...card('Pergunta speckit-1?'), options: choices } }] }));
    expect(await answerer.options([q])).toBe(1);
    const triaged = fact.mock.calls.find(([type]) => type === RefineEvent.SpeckitTriaged)![1] as { results: Array<Record<string, unknown>> };
    expect(triaged.results).toEqual([{ questionId: 'speckit-1', subject: 'Prazo do link', context: q.context, text: q.text, options: choices }]);
    expect(triaged.results[0]).not.toHaveProperty('answer');
  });
});

describe('verifyEvidence', () => {
  it('accepts a whole sentence of one of the six documents, with the heading the server finds above it', () => {
    expect(verifyEvidence(DOCS, [{ source: 'briefing.md', quote: LINK }], '90 dias')).toEqual([{ file: 'briefing.md', heading: 'Regras', quote: LINK }]);
  });

  it('accepts a long part of a sentence when the rest of its line holds no negation', () => {
    expect(verifyEvidence(DOCS, [{ source: 'briefing.md', quote: 'o link de recuperação de senha vale por 90 dias' }], '90 dias')).toHaveLength(1);
  });

  it('refuses a part of a sentence whose rest holds a negation, since the answer would flip the meaning', () => {
    expect(verifyEvidence(DOCS, [{ source: 'briefing.md', quote: 'enviará e-mails de cobrança aos clientes ativos ao fim do mês' }], 'Não há cobrança')).toBeNull();
  });

  it('refuses a quote that joins two lines', () => {
    expect(verifyEvidence(DOCS, [{ source: 'briefing.md', quote: 'vale por 90 dias depois do envio. O sistema não enviará' }], '90 dias')).toBeNull();
  });

  it('refuses a quote of one word, even when it is the number of the answer', () => {
    expect(verifyEvidence(DOCS, [{ source: 'briefing.md', quote: '90' }], '90')).toBeNull();
  });

  it('refuses a quote that is not in the document, even with the same words in another order', () => {
    expect(verifyEvidence(DOCS, [{ source: 'briefing.md', quote: 'dias 90 vale link senha de recuperação o' }], '90 dias')).toBeNull();
  });

  it('refuses a source that is not one of the six documents', () => {
    expect(verifyEvidence(DOCS, [{ source: 'notas.md', quote: LINK }], '90 dias')).toBeNull();
  });

  it('refuses a quote from the owner decisions, which an answer would otherwise cite back', () => {
    expect(verifyEvidence(DOCS, [{ source: 'briefing.md', quote: 'O prazo de recuperação vale por trinta dias corridos para todos os clientes.' }], 'trinta dias')).toBeNull();
  });

  it('refuses an answer whose number no quote holds', () => {
    expect(verifyEvidence(DOCS, [{ source: 'briefing.md', quote: LINK }], '60 dias')).toBeNull();
  });

  it('refuses an answer without evidence', () => {
    expect(verifyEvidence(DOCS, [], '90 dias')).toBeNull();
  });
});

describe('speckitAnswerPack', () => {
  it('gives the six documents and each question with its item, and asks for a null answer when they do not settle it', () => {
    const pack = speckitAnswerPack({ specHash: 'sha256:x', role: 'sm', questions: [{ questionId: 'speckit-1', text: 'Qual o prazo?', itemTitle: 'Entrar' }], texts: DOCS });
    expect(pack).toMatchObject({ kind: 'speckit-answer', role: 'sm' });
    for (const file of ['project.md', 'flow.md', 'briefing.md', 'stack.md', 'design.md', 'specs.md']) expect(pack.feedback).toContain(`### ${file}`);
    expect(pack.feedback).toContain('- speckit-1 (item: Entrar): Qual o prazo?');
    expect(pack.feedback).toContain('Visão do produto.');
    expect(pack.feedback).toContain('answer: null');
  });

  it('asks for options on a yes-or-no question or one that names alternatives, and none only for free text', () => {
    const pack = speckitAnswerPack({ specHash: 'sha256:x', role: 'po', questions: [{ questionId: 'speckit-1', text: 'Qual o prazo?', itemTitle: 'Entrar' }], texts: DOCS });
    expect(pack.feedback).toContain('whenever the question is a yes-or-no question or names alternatives');
    expect(pack.feedback).toContain('free text, such as a name, a number or a date');
  });
});

describe('answererOf', () => {
  it('the PO answers the questions of specify and clarify, the SM those of the constitution, plan and tasks', () => {
    expect(answererOf('specify')).toBe('po');
    expect(answererOf('clarify')).toBe('po');
    expect(answererOf('constitution')).toBe('sm');
    expect(answererOf('plan')).toBe('sm');
    expect(answererOf('tasks')).toBe('sm');
  });
});

describe('makeAnswerer', () => {
  it('answers what the documents settle, and gives every question its card', async () => {
    const { answerer, fact } = harness(() =>
      okOf({
        results: [
          { questionId: 'speckit-1', answer: '90 dias', evidence: [{ source: 'briefing.md', quote: LINK }], card: card('Por quanto tempo vale o link?') },
          { questionId: 'speckit-2', answer: null, evidence: [], card: card('Qual o limite de envios?') },
        ],
      }),
    );
    expect(await answerer.triage([question('speckit-1'), question('speckit-2')])).toBe(1);
    expect(fact).toHaveBeenCalledWith(RefineEvent.SpeckitTriaged, {
      results: [
        { questionId: 'speckit-1', subject: 'Prazo do link', context: 'Item Entrar. Sem prazo, o link fica aberto.', text: 'Por quanto tempo vale o link?', options: [], answer: { text: '90 dias', by: 'po', evidence: [{ file: 'briefing.md', heading: 'Regras', quote: LINK }] } },
        { questionId: 'speckit-2', subject: 'Prazo do link', context: 'Item Entrar. Sem prazo, o link fica aberto.', text: 'Qual o limite de envios?', options: [] },
      ],
    });
  });

  it('keeps the card and drops the answer when no quote holds the number of the answer', async () => {
    const { answerer, fact } = harness(() => okOf({ results: [{ questionId: 'speckit-1', answer: '60 dias', evidence: [{ source: 'briefing.md', quote: LINK }], card: card('Por quanto tempo vale o link?') }] }));
    expect(await answerer.triage([question('speckit-1')])).toBe(0);
    expect(fact).toHaveBeenCalledWith(RefineEvent.SpeckitTriaged, { results: [{ questionId: 'speckit-1', subject: 'Prazo do link', context: 'Item Entrar. Sem prazo, o link fica aberto.', text: 'Por quanto tempo vale o link?', options: [] }] });
  });

  it('asks the PO for the questions of its role, with the item title and the stage folder denied to the agent', async () => {
    const { answerer, runAgent } = harness(() => okOf({ results: [] }));
    await answerer.triage([question('speckit-1')]);
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'speckit-answer', role: 'po', cwd: draft.root, denyRead: [stagingDir] }), expect.anything());
    expect(runAgent.mock.calls[0]![0].pack.feedback).toContain('(item: Entrar): Pergunta speckit-1?');
  });

  it('two failed calls in a row stop the answers for that run', async () => {
    const { answerer, fact, runAgent } = harness(() => failOf('quota'));
    for (const id of ['speckit-1', 'speckit-2', 'speckit-3']) expect(await answerer.triage([question(id)])).toBe(0);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(fact).not.toHaveBeenCalled();
  });

  it('a call that succeeds starts the count of failed calls again', async () => {
    const replies = [failOf('quota'), okOf({ results: [] }), failOf('quota'), okOf({ results: [] })];
    const { answerer, runAgent } = harness(() => replies.shift());
    for (const id of ['speckit-1', 'speckit-2', 'speckit-3', 'speckit-4']) await answerer.triage([question(id)]);
    expect(runAgent).toHaveBeenCalledTimes(4);
  });

  it('asks at most ten questions in one call', async () => {
    const { answerer, runAgent } = harness(() => okOf({ results: [] }));
    await answerer.triage(Array.from({ length: 25 }, (_, i) => question(`speckit-${i}`)));
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it('the PO and the SM answer their own questions, in separate calls', async () => {
    const { answerer, runAgent } = harness(() => okOf({ results: [] }));
    await answerer.triage([question('speckit-1', 'po'), question('speckit-2', 'sm')]);
    expect(runAgent.mock.calls.map(([req]) => req.role)).toEqual(['po', 'sm']);
  });

  it('carries the rework of the step in the same entry as its answers, so the step runs again', async () => {
    const { answerer, fact } = harness(() => okOf({ results: [{ questionId: 'speckit-1', answer: '90 dias', evidence: [{ source: 'briefing.md', quote: LINK }], card: card('Por quanto tempo vale o link?') }] }));
    await answerer.triage([question('speckit-1')], { command: 'plan', itemKey: 'login' });
    expect(fact).toHaveBeenCalledWith(RefineEvent.SpeckitTriaged, expect.objectContaining({ rework: { command: 'plan', itemKey: 'login' } }));
  });

  it('calls nothing when there is no question', async () => {
    const { answerer, fact, runAgent } = harness(() => okOf({ results: [] }));
    expect(await answerer.triage([])).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
    expect(fact).not.toHaveBeenCalled();
  });
});
