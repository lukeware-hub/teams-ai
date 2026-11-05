import { describe, expect, it } from 'vitest';
import { factsOfJournal } from '../../server/usage/cost-facts.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
let seq = 0;
const ev = (type: string, data: Record<string, unknown>, at = '2026-11-05T10:00:00.000Z'): StoredEvent => ({ seq: ++seq, at, runId: 'r', specHash: 'h', type, kind: 'fact', data });

const run = { stage: 'development' as const, projectId: 'shop', specId: 'checkout', runId: 'shop--checkout--run-1' };
const refine = { stage: 'refinement' as const, projectId: 'shop', specId: 'checkout', runId: null };

describe('factsOfJournal: development steps', () => {
  it('joins each finished step to its start for role, kind, model, phase and task', () => {
    const facts = factsOfJournal([
      ev('TASK_PLANNED', { task: { id: 'T1', service: 'shop-api' } }),
      ev('STEP_STARTED', { stepId: 's1', kind: 'dev', role: 'dev', model: 'sonnet', taskId: 'T1', phase: 'phase3', attempt: 1 }),
      ev('STEP_FINISHED', { stepId: 's1', kind: 'dev', taskId: 'T1', attempt: 1, ok: true, model: 'opus', usage: usage(10, 20), costUsd: 0.5 }),
    ], run);
    expect(facts).toEqual([
      expect.objectContaining({ stage: 'development', projectId: 'shop', specId: 'checkout', runId: 'shop--checkout--run-1', repository: 'shop-api', taskId: 'T1', attempt: 1, phase: 'phase3', kind: 'dev', role: 'dev', provider: 'claude', model: 'opus', costUsd: 0.5 }),
    ]);
    expect(facts[0]!.tokens).toEqual(usage(10, 20));
  });

  it('keeps a finished step whose start is missing, with no role', () => {
    const [fact] = factsOfJournal([ev('STEP_FINISHED', { stepId: 's9', kind: 'readme', taskId: null, attempt: 0, usage: usage(1, 2), costUsd: 0.1 })], run);
    expect(fact).toEqual(expect.objectContaining({ role: null, phase: 'desconhecida', kind: 'readme', taskId: null, costUsd: 0.1 }));
  });

  it('counts a step that reported no cost with a null cost', () => {
    const [fact] = factsOfJournal([
      ev('STEP_STARTED', { stepId: 's1', kind: 'test', role: 'test', model: 'haiku', taskId: null, phase: 'phase4', attempt: 0 }),
      ev('STEP_FINISHED', { stepId: 's1', kind: 'test', taskId: null, attempt: 0, usage: usage(3, 4), costUsd: null }),
    ], run);
    expect(fact).toEqual(expect.objectContaining({ costUsd: null, role: 'test' }));
  });

  it('takes the repository of the step from its task; a phase step has none', () => {
    const facts = factsOfJournal([
      ev('TASK_PLANNED', { task: { id: 'T1', service: 'shop-web' } }),
      ev('STEP_STARTED', { stepId: 's1', kind: 'dev', role: 'dev', taskId: 'T1', phase: 'phase3', attempt: 1 }),
      ev('STEP_FINISHED', { stepId: 's1', kind: 'dev', taskId: 'T1', attempt: 1, usage: usage(1, 1), costUsd: 1 }),
      ev('STEP_STARTED', { stepId: 's2', kind: 'report', role: 'sm', taskId: null, phase: 'phase6', attempt: 0 }),
      ev('STEP_FINISHED', { stepId: 's2', kind: 'report', taskId: null, attempt: 0, usage: usage(1, 1), costUsd: 1 }),
    ], run);
    expect(facts.map((f) => f.repository)).toEqual(['shop-web', null]);
  });
});

describe('factsOfJournal: decision calls', () => {
  it('books a Jev, a local and a Claude attempt, each with its own provider and no role', () => {
    const facts = factsOfJournal([
      ev('DECISION_MADE', {
        record: {
          attempts: [
            { backend: 'jev', model: 'jev-model', outcome: 'answered', usage: { inputTokens: 5, outputTokens: 6, costUsd: 0.02 } },
            { backend: 'local', model: 'local-model', outcome: 'answered', usage: { inputTokens: 7, outputTokens: 8, costUsd: 0 } },
            { backend: 'claude', model: 'claude', outcome: 'answered', usage: { inputTokens: 9, outputTokens: 10, costUsd: 0.03 } },
          ],
        },
      }),
    ], run);
    expect(facts.map((f) => [f.kind, f.provider, f.role, f.costUsd])).toEqual([
      ['decisao-jev', 'openrouter', null, 0.02],
      ['decisao-local', 'local', null, 0],
      ['decisao-claude', 'claude', null, 0.03],
    ]);
  });

  it('skips an attempt that made no call (no usage)', () => {
    const facts = factsOfJournal([
      ev('DECISION_MADE', { record: { attempts: [{ backend: 'jev', model: 'm', outcome: 'unavailable', usage: null }] } }),
    ], run);
    expect(facts).toEqual([]);
  });
});

describe('factsOfJournal: refinement', () => {
  it('books the document score of the Jev as a refinement fact', () => {
    const [fact] = factsOfJournal([ev('REFINE_DOCS_SCORED', { model: 'jev-model', usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.04 } })], refine);
    expect(fact).toEqual(expect.objectContaining({ stage: 'refinement', kind: 'avaliacao-jev', provider: 'openrouter', model: 'jev-model', phase: 'refine', costUsd: 0.04, role: null, runId: null }));
    expect(fact!.tokens).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it('skips a document score that made no call', () => {
    expect(factsOfJournal([ev('REFINE_DOCS_SCORED', { model: 'jev-model', usage: null })], refine)).toEqual([]);
  });

  it('books refinement steps under the refinement stage with the draft as the spec', () => {
    const [fact] = factsOfJournal([
      ev('STEP_STARTED', { stepId: 's1', kind: 'spec', role: 'po', model: 'opus', taskId: null, phase: 'refine', attempt: 0 }),
      ev('STEP_FINISHED', { stepId: 's1', kind: 'spec', taskId: null, attempt: 0, usage: usage(1, 1), costUsd: 0.2 }),
    ], refine);
    expect(fact).toEqual(expect.objectContaining({ stage: 'refinement', specId: 'checkout', projectId: 'shop', role: 'po', phase: 'refine', costUsd: 0.2 }));
  });
});
