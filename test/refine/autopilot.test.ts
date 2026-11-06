import { describe, expect, it, vi } from 'vitest';
import { resolveEverything, startIsClear } from '../../server/refine/autopilot.js';
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

  it('leaves to the owner a rewording that changes scope or is unchecked, and an adjustment approval', () => {
    expect(autoAcceptable(patch({ replace: 'O cliente paga por cartão.', scopeChange: true }), true)).toBe(false);
    expect(autoAcceptable(patch({ replace: 'O cliente paga por cartão.' }), true)).toBe(false);
    expect(autoAcceptable(patch({ find: '', replace: '## Ajuste aprovado: login-ajuste-1\n\ntexto\n' }), true)).toBe(false);
  });
});
