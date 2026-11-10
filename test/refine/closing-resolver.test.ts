import { describe, expect, it, vi } from 'vitest';
import { resolveClosing, safePatches } from '../../server/refine/closing-resolver.js';
import { ConflictError, type RefineSession } from '../../server/refine/session.js';
import type { PatchRow } from '../../server/refine/state.js';

type Check = { id: string; ok: boolean; detail: string };
const summary = (checks: Check[], summaryHash = 'h') => ({ ok: checks.every((c) => c.ok), summaryHash, checks, repositories: [], assumptions: [] });
const patch = (patchId: string, over: Partial<PatchRow> = {}): PatchRow => ({ patchId, role: 'sm', file: 'stack.md', find: 'a', replace: 'b', reason: '', diff: '', status: 'pending', cycle: 1, ...over } as PatchRow);

/** A session stand-in: the summary the test sets, and every call the resolver makes is recorded. */
function fakeSession(opts: { summaries: ReturnType<typeof summary>[]; patches?: PatchRow[]; architecture?: unknown; stale?: boolean; staleBy?: Record<string, string>; doneStages?: string[]; graphed?: string[]; reviewClosed?: boolean; accept?: (id: string) => Promise<void> }) {
  let i = 0;
  const s = {
    addToGraph: vi.fn(async () => undefined),
    state: { repositories: true, doneStages: opts.doneStages, graphed: opts.graphed, patches: opts.patches ?? [], architecture: opts.architecture ?? { docsHash: 'd' }, staleBy: opts.staleBy, reviewClosed: opts.reviewClosed ?? true },
    evaluateStage: vi.fn(async () => undefined),
    closingSummary: vi.fn(async () => opts.summaries[Math.min(i++, opts.summaries.length - 1)]),
    accept: vi.fn(opts.accept ?? (async () => undefined)),
    evaluate: vi.fn(async () => undefined),
    isArchitectureStale: vi.fn(async () => opts.stale ?? false),
    decideArchitecture: vi.fn(async () => undefined),
    runPlans: vi.fn(async () => undefined),
    settled: vi.fn(async () => undefined),
  };
  return s;
}

describe('resolveClosing', () => {
  it('does nothing when the closing summary already passes', async () => {
    const s = fakeSession({ summaries: [summary([{ id: 'plans', ok: true, detail: '' }])] });
    await resolveClosing(s as unknown as RefineSession);
    expect(s.accept).not.toHaveBeenCalled();
    expect(s.runPlans).not.toHaveBeenCalled();
  });

  it('accepts the safe patches, evaluates, and stops once the summary passes', async () => {
    const s = fakeSession({
      summaries: [summary([{ id: 'questions', ok: false, detail: 'x' }], 'h1'), summary([{ id: 'questions', ok: true, detail: '' }], 'h2')],
      patches: [patch('p1'), patch('p2', { scopeChange: true })],
    });
    await resolveClosing(s as unknown as RefineSession);
    expect(s.accept).toHaveBeenCalledTimes(1);
    expect(s.accept).toHaveBeenCalledWith('p1', false);
    expect(s.evaluate).toHaveBeenCalledTimes(1);
    expect(s.runPlans).not.toHaveBeenCalled();
  });

  it('accepts only the patches the given rule allows', async () => {
    const s = fakeSession({
      summaries: [summary([{ id: 'questions', ok: false, detail: 'x' }], 'h1'), summary([{ id: 'questions', ok: false, detail: 'x' }], 'h1')],
      patches: [patch('keep', { file: 'briefing.md' }), patch('skip', { file: 'stack.md' })],
    });
    await resolveClosing(s as unknown as RefineSession, (p) => p.file === 'briefing.md');
    expect(s.accept).toHaveBeenCalledTimes(1);
    expect(s.accept).toHaveBeenCalledWith('keep', false);
  });

  it('does not review an outdated stage again: the mark is only a notice', async () => {
    const s = fakeSession({
      summaries: [summary([{ id: 'questions', ok: false, detail: 'x' }], 'h1'), summary([{ id: 'questions', ok: true, detail: '' }], 'h2')],
      staleBy: { 'stack.md': 'briefing.md', 'design.md': 'briefing.md' },
    });
    await resolveClosing(s as unknown as RefineSession);
    expect(s.evaluateStage).not.toHaveBeenCalled();
  });

  it('before the review closes, resolves only the stages: safe patches, no review and no later step', async () => {
    const s = fakeSession({
      summaries: [summary([{ id: 'questions', ok: false, detail: 'x' }])],
      staleBy: { 'stack.md': 'briefing.md' },
      patches: [patch('p1')],
      reviewClosed: false,
      architecture: null,
    });
    await resolveClosing(s as unknown as RefineSession);
    expect(s.evaluateStage).not.toHaveBeenCalled();
    expect(s.accept).toHaveBeenCalledWith('p1', false);
    expect(s.decideArchitecture).not.toHaveBeenCalled();
    expect(s.runPlans).not.toHaveBeenCalled();
  });

  it('puts a finished document that left the graph back in', async () => {
    const s = fakeSession({
      summaries: [summary([{ id: 'documents', ok: false, detail: 'x' }], 'h1'), summary([{ id: 'documents', ok: true, detail: '' }], 'h2')],
      doneStages: ['flow.md', 'project.md'],
      graphed: ['flow.md'],
    });
    await resolveClosing(s as unknown as RefineSession);
    expect(s.addToGraph.mock.calls).toEqual([['project.md']]);
  });

  it('a second call while one runs does nothing', async () => {
    const s = fakeSession({ summaries: [summary([{ id: 'questions', ok: false, detail: 'x' }], 'h1'), summary([{ id: 'questions', ok: true, detail: '' }], 'h2')], patches: [patch('p1')] });
    await Promise.all([resolveClosing(s as unknown as RefineSession), resolveClosing(s as unknown as RefineSession)]);
    expect(s.accept).toHaveBeenCalledTimes(1);
  });

  it('decides the architecture again when it is stale, and waits for it to settle', async () => {
    const s = fakeSession({
      summaries: [summary([{ id: 'architecture', ok: false, detail: 'a' }], 'h1'), summary([{ id: 'architecture', ok: true, detail: '' }], 'h2')],
      stale: true,
    });
    await resolveClosing(s as unknown as RefineSession);
    expect(s.decideArchitecture).toHaveBeenCalledTimes(1);
    expect(s.settled).toHaveBeenCalled();
  });

  it('prepares the plans when plans or tasks are still missing', async () => {
    const s = fakeSession({
      summaries: [
        summary([{ id: 'plans', ok: false, detail: 'sem plano: a' }], 'h1'),
        summary([{ id: 'plans', ok: false, detail: 'sem plano: a' }], 'h1'),
        summary([{ id: 'plans', ok: true, detail: '' }], 'h2'),
      ],
    });
    await resolveClosing(s as unknown as RefineSession);
    expect(s.runPlans).toHaveBeenCalledTimes(1);
  });

  it('stops when a round changes nothing in the summary', async () => {
    const s = fakeSession({ summaries: [summary([{ id: 'plans', ok: false, detail: 'sem plano: a' }], 'same')] });
    await resolveClosing(s as unknown as RefineSession);
    expect(s.runPlans).toHaveBeenCalledTimes(1);
    expect(s.closingSummary).toHaveBeenCalledTimes(3);
  });

  it('ends quietly when the owner must act, for a refused step', async () => {
    const s = fakeSession({ summaries: [summary([{ id: 'plans', ok: false, detail: 'sem plano: a' }], 'h1')] });
    s.runPlans.mockRejectedValueOnce(new ConflictError('Detalhe o backlog antes de preparar os planos'));
    await expect(resolveClosing(s as unknown as RefineSession)).resolves.toBeUndefined();
  });
});

describe('safePatches', () => {
  it('keeps only pending patches that change no scope', () => {
    const rows = [patch('ok'), patch('scope', { scopeChange: true }), patch('done', { status: 'accepted' })];
    expect(safePatches(rows).map((p) => p.patchId)).toEqual(['ok']);
  });
});

describe('a follow-on request closes without the review step', () => {
  it('decides the architecture the documents changed, as the review would for a project', async () => {
    const s = fakeSession({ summaries: [summary([{ id: 'architecture', ok: false, detail: 'x' }], 'h1'), summary([{ id: 'architecture', ok: true, detail: '' }], 'h2')], stale: true });
    (s.state as unknown as { extension?: unknown }).extension = { requestId: 'pedido-1' };
    await resolveClosing(s as unknown as RefineSession);
    expect(s.decideArchitecture).toHaveBeenCalledTimes(1);
  });
});
