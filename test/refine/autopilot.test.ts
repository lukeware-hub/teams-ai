import { describe, expect, it, vi } from 'vitest';
import { resolveEverything, startIsClear } from '../../server/refine/autopilot.js';
import { ConflictError, type RefineSession } from '../../server/refine/session.js';

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
    specsApproved: over.specsApproved ?? (() => true),
  };
  return s;
}

describe('resolveEverything', () => {
  it('accepts every suggestion, answers every question, evaluates, settles specs.md and prepares the plans', async () => {
    const s = fake({ patches: [{ patchId: 'p1', status: 'pending', scopeChange: true, reason: '', find: 'a', replace: 'b', file: 'flow.md' }], questions: [{ questionId: 'q1', status: 'pending', blocking: true }] });
    await resolveEverything(s as unknown as RefineSession);
    expect(s.accept).toHaveBeenCalledWith('p1');
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
    expect(s.startSpecs).toHaveBeenCalledTimes(3);
    expect(s.approveSpecsAnyway).toHaveBeenCalledTimes(1);
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
});

describe('startIsClear', () => {
  it('needs the backlog ready, no blocking question, specs.md approved and the plans prepared', async () => {
    const ready = fake({ status: 'ready', plansDone: true });
    expect(await startIsClear(ready as unknown as RefineSession)).toBe(true);
    expect(await startIsClear(fake({ status: 'ready' }) as unknown as RefineSession)).toBe(false);
    expect(await startIsClear(fake({ status: 'ready', plansDone: true, questions: [{ questionId: 'q', status: 'pending', blocking: true }] }) as unknown as RefineSession)).toBe(false);
  });
});
