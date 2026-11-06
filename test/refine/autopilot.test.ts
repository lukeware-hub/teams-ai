import { describe, expect, it, vi } from 'vitest';
import { acceptAllPending, leftForOwner, resolveEverything, runExtension, startIsClear } from '../../server/refine/autopilot.js';
import { ConflictError, type RefineSession } from '../../server/refine/session.js';
import { autoAcceptable } from '../../server/refine/team-rule.js';

/** A session stand-in: the state the test sets, and every call the autopilot makes is recorded. */
function fake(over: { patches?: unknown[]; questions?: unknown[]; status?: string; specsApproved?: () => boolean; plansDone?: boolean; specsMd?: unknown } = {}) {
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
    specsApproved: over.specsApproved ?? (() => true),
  };
  return s;
}

describe('resolveEverything', () => {
  it('accepts every suggestion, answers every question, evaluates, settles specs.md and prepares the plans', async () => {
    const s = fake({ patches: [{ patchId: 'p1', status: 'pending', scopeChange: true, reason: '', find: 'a', replace: 'b', file: 'flow.md' }], questions: [{ questionId: 'q1', status: 'pending', blocking: true }] });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.accept).toHaveBeenCalledWith('p1', false);
    expect(s.decideAnswer).toHaveBeenCalledWith('q1');
    expect(s.evaluate).toHaveBeenCalledTimes(1);
    expect(s.startSpecs).toHaveBeenCalledWith({ autonomous: true });
    expect(s.runPlans).toHaveBeenCalledTimes(1);
    expect(s.approveSpecsAnyway).not.toHaveBeenCalled();
  });

  it('does nothing when the start is already clear', async () => {
    const s = fake({ status: 'ready', plansDone: true });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.accept).not.toHaveBeenCalled();
    expect(s.startSpecs).not.toHaveBeenCalled();
  });

  it('follows a specs.md a reviewer still rejects after the rounds, on the owner behalf', async () => {
    const s = fake({ status: 'ready', plansDone: true, specsApproved: () => false });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.startSpecs).toHaveBeenCalledTimes(5);
    expect(s.approveSpecsAnyway).toHaveBeenCalledTimes(1);
  });

  it('at the end puts every missing document in the graph and saves the documents in the repositories', async () => {
    const s = fake({ status: 'ready', plansDone: true });
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
    const s = fake({ questions: [{ questionId: 'q1', status: 'pending', blocking: true }] });
    await Promise.all([resolveEverything(s as unknown as RefineSession), resolveEverything(s as unknown as RefineSession)]);
    expect(s.decideAnswer).toHaveBeenCalledTimes(1);
  });

  it('a follow-on request the team runs alone follows the specs.md and graphs the five documents in one go, but leaves the save in the repositories to the owner', async () => {
    const s = fake({ status: 'ready', plansDone: true, specsApproved: () => false });
    s.state.extension = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar', at: '2026-11-04T00:00:00.000Z' };
    await resolveEverything(s as unknown as RefineSession, { byOwner: false });
    expect(s.approveSpecsAnyway).toHaveBeenCalledTimes(1);
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
  });

  it('a follow-on request the owner runs follows the specs.md and saves the documents, as his button says', async () => {
    const s = fake({ status: 'ready', plansDone: true, specsApproved: () => false });
    s.state.extension = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar', at: '2026-11-04T00:00:00.000Z' };
    await resolveEverything(s as unknown as RefineSession);
    expect(s.approveSpecsAnyway).toHaveBeenCalledTimes(1);
    expect(s.saveDocs).toHaveBeenCalledTimes(1);
  });
});

describe('acceptAllPending: the owner takes every suggestion at once', () => {
  const row = (patchId: string, status = 'pending') => ({ patchId, status, scopeChange: true, reason: '', find: 'a', replace: 'b', file: 'flow.md' });

  it('accepts each pending suggestion, in order, and says how many', async () => {
    const s = fake({ patches: [row('a'), row('b', 'accepted'), row('c')] });
    expect(await acceptAllPending(s as unknown as RefineSession)).toBe(2);
    expect(s.accept.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
  });

  it('skips one that another change already covered and goes on with the rest', async () => {
    const s = fake({ patches: [row('a'), row('b')] });
    s.accept.mockRejectedValueOnce(new ConflictError('já foi coberto'));
    expect(await acceptAllPending(s as unknown as RefineSession)).toBe(1);
    expect(s.accept.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('accepts nothing and says zero when no suggestion waits', async () => {
    const s = fake();
    expect(await acceptAllPending(s as unknown as RefineSession)).toBe(0);
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

describe('lean refinement: one evaluation, then the team settles what the reviewers found', () => {
  const extension = { requestId: 'pedido-1', title: 'Exportar', text: 'Exportar', at: '2026-11-04T00:00:00.000Z' };

  it('applies the fixes and settles the checks without evaluating again', async () => {
    const s = fake({ status: 'answering', plansDone: true, questions: [{ questionId: 'q1', status: 'pending', blocking: true }], patches: [{ patchId: 'p1', status: 'pending', scopeChange: false, reason: '', find: 'a', replace: 'b', file: 'flow.md' }] });
    s.state.extension = extension;
    await resolveEverything(s as unknown as RefineSession, { byOwner: false });
    expect(s.accept).toHaveBeenCalledWith('p1', true);
    expect(s.decideAnswer).toHaveBeenCalledWith('q1');
    expect(s.settleChecklist).toHaveBeenCalled();
    expect(s.reviewSpecsBeside).toHaveBeenCalled();
    expect(s.evaluate).not.toHaveBeenCalled();
  });

  it('says why the team stopped when a cycle failed or a reviewer rejected specs.md, without blocking the start', () => {
    const s = fake({ status: 'ready', plansDone: true });
    s.state.error = 'A sessão do Claude expirou.';
    s.state.specsMd = { hash: 'h1' } as never;
    s.state.specsReview = { po: { specsHash: 'h1', verdict: 'rejected', findings: ['x'] }, sm: { specsHash: 'h1', verdict: 'approved', findings: [] } } as never;
    expect(leftForOwner(s as unknown as RefineSession)).toEqual(['A sessão do Claude expirou.', expect.stringContaining('PO apontaram problemas no specs.md')]);
  });

  it('does not settle the checks while something still waits for the owner', async () => {
    const s = fake({ status: 'answering', plansDone: true, patches: [{ patchId: 'scope', status: 'pending', scopeChange: true, reason: '', find: 'x', replace: 'y', file: 'design.md' }] });
    s.state.extension = extension;
    await resolveEverything(s as unknown as RefineSession, { byOwner: false });
    expect(s.settleChecklist).not.toHaveBeenCalled();
  });

  it('keeps the owner path as it was: the owner button still evaluates again', async () => {
    const s = fake({ status: 'answering', plansDone: true });
    s.state.extension = extension;
    await resolveEverything(s as unknown as RefineSession);
    expect(s.evaluate).toHaveBeenCalled();
    expect(s.settleChecklist).not.toHaveBeenCalled();
  });
});

describe('leftForOwner', () => {
  it('says nothing when nothing is left, and names a failed plan preparation', () => {
    expect(leftForOwner({ state: { questions: [], patches: [] } } as never)).toEqual([]);
    expect(leftForOwner({ state: { questions: [], patches: [], speckit: { status: 'failed' } } } as never)).toEqual(['A preparação dos planos falhou.']);
  });
});

describe('startIsClear', () => {
  it('needs the backlog ready, no blocking question, specs.md approved and the plans prepared', async () => {
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
