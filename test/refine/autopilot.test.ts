import { describe, expect, it, vi } from 'vitest';
import { acceptAllPending, decideWhenDelegated, haltTeam, ownerResumed, leftForOwner, resolveEverything, runExtension, startIsClear } from '../../server/refine/autopilot.js';
import { ConflictError, type RefineSession } from '../../server/refine/session.js';
import { autoAcceptable } from '../../server/refine/team-rule.js';

/** A session stand-in: the state the test sets, and every call the autopilot makes is recorded. */
function fake(over: { patches?: unknown[]; questions?: unknown[]; status?: string; specsReady?: () => boolean; plansDone?: boolean; specsMd?: unknown; agentsDecide?: boolean } = {}) {
  const state: Record<string, unknown> = {
    status: over.status ?? 'answering',
    patches: over.patches ?? [],
    questions: over.questions ?? [],
    backlog: { enabled: true, detail: true, items: [{ key: 'base' }] },
    speckit: over.plansDone ? { status: 'done', stale: false, steps: [] } : undefined,
    specsMd: over.specsMd === undefined ? { hash: 'h', bytes: 1 } : over.specsMd,
    staleBy: {},
    graphed: ['project.md', 'briefing.md'],
  };
  const s = {
    state,
    accept: vi.fn(async (id: string) => { (state.patches as Array<{ patchId: string; status: string }>).find((p) => p.patchId === id)!.status = 'accepted'; }),
    decide: vi.fn(async (_d: { kind: string; id: string }): Promise<boolean> => false),
    decideAnswer: vi.fn(async (id: string) => { (state.questions as Array<{ questionId: string; status: string }>).find((q) => q.questionId === id)!.status = 'answered'; }),
    evaluate: vi.fn(async () => { state.status = 'ready'; }),
    startSpecs: vi.fn(() => Promise.resolve()),
    runPlans: vi.fn(async () => { state.speckit = { status: 'done', stale: false, steps: [] }; }),
    approveSpecsAnyway: vi.fn(async () => undefined),
    settled: vi.fn(async () => undefined),
    evaluateStage: vi.fn(async () => undefined),
    addToGraph: vi.fn(async (file: string) => { (state.graphed as string[]).push(file); }),
    graphDocs: vi.fn(async () => undefined),
    closingSummary: vi.fn(async () => ({ ok: true, summaryHash: 'h', checks: [], repositories: [], assumptions: [] })),
    saveDocs: vi.fn(async () => undefined),
    teamAutopilot: vi.fn(async () => undefined),
    settleChecklist: vi.fn(async () => { state.status = 'ready'; }),
    reviewSpecsBeside: vi.fn(async () => {}),
    specsReady: over.specsReady ?? (() => true),
    proceedWithout: vi.fn(async () => { for (const p of state.patches as Array<{ status: string }>) if (p.status === 'pending') p.status = 'rejected'; for (const q of state.questions as Array<{ status: string }>) if (q.status === 'pending') q.status = 'answered'; }),
    agentsDecide: vi.fn(async () => over.agentsDecide ?? false),
  };
  return s;
}

describe('resolveEverything: one pass, no review runs twice', () => {
  it('takes the suggestions, has the PO answer the rest, evaluates, writes specs.md and prepares the plans', async () => {
    const s = fake({ patches: [{ patchId: 'p1', status: 'pending', scopeChange: true, reason: '', find: 'a', replace: 'b', file: 'flow.md' }], questions: [{ questionId: 'q1', status: 'pending', blocking: true }] });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.accept).toHaveBeenCalledWith('p1', false);
    expect(s.proceedWithout).toHaveBeenCalled();
    expect(s.evaluate).toHaveBeenCalledTimes(1);
    expect(s.startSpecs).toHaveBeenCalledTimes(1);
    expect(s.runPlans).toHaveBeenCalledTimes(1);
  });

  it('with a ready backlog, writes specs.md once and goes on to the plans', async () => {
    const s = fake({ status: 'ready', specsReady: () => false });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.evaluate).not.toHaveBeenCalled();
    expect(s.startSpecs).toHaveBeenCalledTimes(1);
    expect(s.runPlans).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the start is already clear', async () => {
    const s = fake({ status: 'ready', plansDone: true });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.accept).not.toHaveBeenCalled();
    expect(s.startSpecs).not.toHaveBeenCalled();
  });

  it('at the end puts every missing document in the graph and saves the documents in the repositories', async () => {
    const s = fake({ status: 'ready', specsReady: () => false });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.addToGraph.mock.calls.map((c) => c[0])).toEqual(['flow.md', 'stack.md', 'design.md']);
    expect(s.saveDocs).toHaveBeenCalledTimes(1);
  });

  it('goes on to the next step when the session refuses one for the moment it is in', async () => {
    const s = fake({ patches: [{ patchId: 'p1', status: 'pending', reason: '', find: 'a', replace: 'b', file: 'flow.md' }] });
    s.accept.mockRejectedValue(new ConflictError('já decidida'));
    await resolveEverything(s as unknown as RefineSession);
    expect(s.evaluate).toHaveBeenCalled();
    expect(s.runPlans).toHaveBeenCalled();
  });

  it('two calls at once run one autopilot', async () => {
    const s = fake();
    await Promise.all([resolveEverything(s as unknown as RefineSession), resolveEverything(s as unknown as RefineSession)]);
    expect(s.evaluate).toHaveBeenCalledTimes(1);
  });

  it('a follow-on request the team runs alone graphs the five documents in one go, but leaves the save in the repositories to the owner', async () => {
    const s = fake({ status: 'ready', specsReady: () => false });
    s.state.extension = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar', at: '2026-11-04T00:00:00.000Z' };
    await resolveEverything(s as unknown as RefineSession, { byOwner: false });
    expect(s.closingSummary).toHaveBeenCalled();
    expect(s.saveDocs).not.toHaveBeenCalled();
    expect(s.graphDocs).toHaveBeenCalledTimes(1);
    expect(s.addToGraph).not.toHaveBeenCalled();
  });

  it('a follow-on request the team runs alone accepts additions and rewordings that change no scope, marked as automatic, and leaves a scope change to the owner', async () => {
    const s = fake({ patches: [
      { patchId: 'add', status: 'pending', reason: '', find: 'O cliente paga.', replace: 'O cliente paga.\n- Exporta.', file: 'briefing.md' },
      { patchId: 'reword', status: 'pending', scopeChange: false, reason: '', find: 'a', replace: 'b', file: 'flow.md' },
      { patchId: 'scope', status: 'pending', scopeChange: true, reason: '', find: 'x', replace: 'y', file: 'design.md' },
    ] });
    s.state.extension = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar', at: '2026-11-04T00:00:00.000Z' };
    await resolveEverything(s as unknown as RefineSession, { byOwner: false });
    expect(s.accept).toHaveBeenCalledWith('add', true);
    expect(s.accept).toHaveBeenCalledWith('reword', true);
    expect(s.accept).not.toHaveBeenCalledWith('scope', expect.anything());
    expect(s.proceedWithout).not.toHaveBeenCalled();
  });

  it('a follow-on request the owner runs saves the documents, as his button says', async () => {
    const s = fake({ status: 'ready', specsReady: () => false });
    s.state.extension = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar', at: '2026-11-04T00:00:00.000Z' };
    await resolveEverything(s as unknown as RefineSession);
    expect(s.saveDocs).toHaveBeenCalledTimes(1);
  });
});

describe('the team stops when the owner says so', () => {
  it('Parar ends the whole team: nothing starts after it', async () => {
    const s = fake();
    s.evaluate.mockImplementation(async () => {
      haltTeam(s as unknown as RefineSession);
    });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.evaluate).toHaveBeenCalledTimes(1);
    expect(s.startSpecs).not.toHaveBeenCalled();
    expect(s.runPlans).not.toHaveBeenCalled();
  });

  it('Parar while a document goes back to the graph puts no other one back and starts no evaluation', async () => {
    const s = fake({ questions: [{ questionId: 'q1', status: 'pending', blocking: true }] });
    s.state.repositories = true;
    s.state.doneStages = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];
    s.state.graphed = [];
    s.addToGraph.mockImplementation(async () => {
      haltTeam(s as unknown as RefineSession);
    });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.addToGraph).toHaveBeenCalledTimes(1);
    expect(s.evaluateStage).not.toHaveBeenCalled();
    expect(s.proceedWithout).not.toHaveBeenCalled();
    expect(s.evaluate).not.toHaveBeenCalled();
  });

  it('a halt left from an earlier run does not stop the next one', async () => {
    const s = fake();
    haltTeam(s as unknown as RefineSession);
    await resolveEverything(s as unknown as RefineSession);
    expect(s.evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('acceptAllPending: the owner takes every suggestion at once', () => {
  const row = (patchId: string, status = 'pending') => ({ patchId, status, scopeChange: true, reason: '', find: 'a', replace: 'b', file: 'flow.md' });

  it('accepts each pending suggestion, in order, and says how many', async () => {
    const s = fake({ patches: [row('a'), row('b', 'accepted'), row('c')] });
    expect(await acceptAllPending(s as unknown as RefineSession)).toEqual({ accepted: 2, queued: 0 });
    expect(s.decide.mock.calls.map((c) => c[0])).toEqual([{ kind: 'accept', id: 'a' }, { kind: 'accept', id: 'c' }]);
  });

  it('skips one that another change already covered and goes on with the rest', async () => {
    const s = fake({ patches: [row('a'), row('b')] });
    s.decide.mockRejectedValueOnce(new ConflictError('já foi coberto'));
    expect(await acceptAllPending(s as unknown as RefineSession)).toEqual({ accepted: 1, queued: 0 });
    expect(s.decide.mock.calls.map((c) => c[0].id)).toEqual(['a', 'b']);
  });

  it('queues them while the team works, and skips one already queued', async () => {
    const s = fake({ patches: [row('a'), row('b')] });
    s.state.queued = [{ kind: 'accept', id: 'a' }];
    s.decide.mockResolvedValue(true);
    expect(await acceptAllPending(s as unknown as RefineSession)).toEqual({ accepted: 0, queued: 1 });
    expect(s.decide.mock.calls.map((c) => c[0].id)).toEqual(['b']);
  });

  it('accepts nothing and says zero when no suggestion waits', async () => {
    const s = fake();
    expect(await acceptAllPending(s as unknown as RefineSession)).toEqual({ accepted: 0, queued: 0 });
  });
});

describe('decideWhenDelegated: the Settings answer to "agents decide" also holds in the refinement', () => {
  const pending = () => ({ patches: [{ patchId: 'p1', status: 'pending', scopeChange: true, reason: '', find: 'a', replace: 'b', file: 'stack.md' }], questions: [{ questionId: 'q1', status: 'pending', blocking: true }] });

  it('with yes, the team decides what waits: it takes the suggestion and answers the question', async () => {
    const s = fake({ ...pending(), agentsDecide: true });
    await decideWhenDelegated(s as unknown as RefineSession);
    expect(s.accept).toHaveBeenCalledWith('p1', false);
    expect(s.proceedWithout).toHaveBeenCalled();
  });

  it('with no, everything waits for the owner', async () => {
    const s = fake({ ...pending(), agentsDecide: false });
    await decideWhenDelegated(s as unknown as RefineSession);
    expect(s.accept).not.toHaveBeenCalled();
    expect(s.decideAnswer).not.toHaveBeenCalled();
  });

  it('with yes and the start already clear, the team starts nothing', async () => {
    const s = fake({ agentsDecide: true, status: 'ready', plansDone: true });
    await decideWhenDelegated(s as unknown as RefineSession);
    expect(s.startSpecs).not.toHaveBeenCalled();
  });

  it('with yes, nothing waiting but specs.md not written and no plans, the team writes specs.md and prepares the plans', async () => {
    const s = fake({ agentsDecide: true, status: 'ready', specsReady: () => false });
    await decideWhenDelegated(s as unknown as RefineSession);
    expect(s.startSpecs).toHaveBeenCalled();
    expect(s.runPlans).toHaveBeenCalled();
  });

  it('after Parar, yes does not start the team again until the owner starts work', async () => {
    const s = fake({ agentsDecide: true, status: 'ready', specsReady: () => false });
    haltTeam(s as unknown as RefineSession);
    await decideWhenDelegated(s as unknown as RefineSession);
    expect(s.startSpecs).not.toHaveBeenCalled();
    ownerResumed(s as unknown as RefineSession);
    await decideWhenDelegated(s as unknown as RefineSession);
    expect(s.startSpecs).toHaveBeenCalled();
  });

  it('with no, an unwritten specs.md waits for the owner', async () => {
    const s = fake({ agentsDecide: false, status: 'ready', specsReady: () => false });
    await decideWhenDelegated(s as unknown as RefineSession);
    expect(s.startSpecs).not.toHaveBeenCalled();
  });

  it('with yes on a follow-on request, the team runs it alone without a new evaluation', async () => {
    const s = fake({ ...pending(), agentsDecide: true });
    s.state.extension = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar', at: '2026-11-04T00:00:00.000Z' };
    await decideWhenDelegated(s as unknown as RefineSession);
    expect(s.teamAutopilot).toHaveBeenCalledWith('started');
    expect(s.evaluate).not.toHaveBeenCalled();
  });
});

describe('runExtension: the team starts and stops are journaled, so the screen asks the owner only for what is left', () => {
  const extension = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar', at: '2026-11-04T00:00:00.000Z' };

  it('starts, resolves and stops with no reason when everything is settled', async () => {
    const s = fake({ status: 'ready', plansDone: true });
    s.state.extension = extension;
    await runExtension(s as unknown as RefineSession);
    expect(s.teamAutopilot.mock.calls).toEqual([['started'], ['stopped', []]]);
  });

  it('runs again without a new evaluation when the owner already decided the suggestions', async () => {
    const s = fake({ status: 'ready', plansDone: true });
    s.state.extension = extension;
    await runExtension(s as unknown as RefineSession, { evaluate: false });
    expect(s.evaluate).not.toHaveBeenCalled();
    expect(s.teamAutopilot.mock.calls).toEqual([['started'], ['stopped', []]]);
  });

  it('stops listing the question the team could not decide and the suggestion that changes scope', async () => {
    const s = fake({ status: 'ready', plansDone: true, questions: [{ questionId: 'q1', status: 'pending', blocking: true }], patches: [{ patchId: 'scope', status: 'pending', scopeChange: true, reason: '', find: 'x', replace: 'y', file: 'design.md' }] });
    s.state.extension = extension;
    s.decideAnswer.mockRejectedValue(new ConflictError('O PO não conseguiu decidir'));
    await runExtension(s as unknown as RefineSession);
    expect(s.teamAutopilot).toHaveBeenLastCalledWith('stopped', ['O time não conseguiu decidir 1 pergunta.', '1 sugestão muda o escopo e espera a sua decisão.']);
  });

  it('still journals the stop, with the error, when the evaluation throws', async () => {
    const s = fake();
    s.state.extension = extension;
    s.evaluate.mockRejectedValue(new Error('limite de rodadas'));
    await expect(runExtension(s as unknown as RefineSession)).rejects.toThrow('limite de rodadas');
    expect(s.teamAutopilot).toHaveBeenLastCalledWith('stopped', ['O time parou com um erro: limite de rodadas']);
  });

  it('takes in the last pass a suggestion proposed after the rounds, so none the team may accept is left', async () => {
    const s = fake({ status: 'ready', plansDone: true });
    s.state.extension = extension;
    (s.state.patches as unknown[]).push({ patchId: 'late', status: 'pending', scopeChange: false, reason: '', find: 'a', replace: 'b', file: 'flow.md' });
    await runExtension(s as unknown as RefineSession);
    expect(s.accept).toHaveBeenCalledWith('late', true);
  });
});

describe('leftForOwner when the team stops', () => {
  it('says why the team stopped when a cycle failed', () => {
    const s = fake({ status: 'ready', plansDone: true });
    s.state.error = 'A sessão do Claude expirou.';
    expect(leftForOwner(s as unknown as RefineSession)).toEqual(['A sessão do Claude expirou.']);
  });
});


describe('leftForOwner', () => {
  it('says nothing when nothing is left, and names a failed plan preparation', () => {
    expect(leftForOwner({ state: { questions: [], patches: [] } } as never)).toEqual([]);
    expect(leftForOwner({ state: { questions: [], patches: [], speckit: { status: 'failed' } } } as never)).toEqual(['A preparação dos planos falhou.']);
  });
});

describe('startIsClear', () => {
  it('needs the backlog ready, no blocking question, specs.md written and the plans prepared', async () => {
    const ready = fake({ status: 'ready', plansDone: true });
    expect(await startIsClear(ready as unknown as RefineSession)).toBe(true);
    expect(await startIsClear(fake({ status: 'ready' }) as unknown as RefineSession)).toBe(false);
    expect(await startIsClear(fake({ status: 'ready', plansDone: true, questions: [{ questionId: 'q', status: 'pending', blocking: true }] }) as unknown as RefineSession)).toBe(false);
  });
});

describe('autoAcceptable: the team accepts on its own what adds to a document or rewords it without changing scope', () => {
  const patch = (over: Record<string, string | boolean>) => ({ file: 'briefing.md', find: 'O cliente paga.', replace: 'O cliente paga.\n- Exporta.', status: 'pending', ...over }) as never;

  it('accepts every suggestion of a session that is not a request, as before', () => {
    expect(autoAcceptable(patch({ replace: 'O cliente paga por cartão.' }), false)).toBe(true);
  });

  it('accepts an addition to any document of a request', () => {
    for (const file of ['briefing.md', 'flow.md', 'project.md', 'stack.md', 'design.md']) expect(autoAcceptable(patch({ file }), true)).toBe(true);
  });

  it('accepts a rewording that the scope guard says changes no scope', () => {
    expect(autoAcceptable(patch({ replace: 'O cliente paga por cartão.', scopeChange: false }), true)).toBe(true);
  });

  it('leaves to the owner a removal, even when the scope guard sees no scope change', () => {
    expect(autoAcceptable(patch({ replace: '', scopeChange: false }), true)).toBe(false);
  });

  it('leaves to the owner a rewording that changes scope or is unchecked, and an adjustment approval', () => {
    expect(autoAcceptable(patch({ replace: 'O cliente paga por cartão.', scopeChange: true }), true)).toBe(false);
    expect(autoAcceptable(patch({ replace: 'O cliente paga por cartão.' }), true)).toBe(false);
    expect(autoAcceptable(patch({ find: '', replace: '## Ajuste aprovado: login-ajuste-1\n\ntexto\n' }), true)).toBe(false);
  });
});
