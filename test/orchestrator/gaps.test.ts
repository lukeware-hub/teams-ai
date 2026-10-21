import { describe, expect, it, vi } from 'vitest';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { EvidenceRow } from '../../server/evidence/matrix.js';
import { citedSections, checkGaps, explainGaps, gapCause, gapErrors, type GapContext } from '../../server/orchestrator/phases/gaps.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/index.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { DEPENDENCY_BLOCKED } from '../../server/pipeline/task-state.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';

const row = (criterion: string, status: EvidenceRow['status'], tasks: string[]): EvidenceRow => ({ criterion, status, tasks, tests: [] });

function ctx(over: Partial<GapContext> = {}): GapContext {
  return {
    evidence: [],
    tasks: new Map(),
    reasonOf: () => 'blocked',
    result: 'awaiting-validation',
    ...over,
  };
}

describe('gap causes', () => {
  it('names no cause for a delivered section', () => {
    const [item] = explainGaps([{ status: 'delivered' as const, acIds: ['AC1'] }], ctx({ evidence: [row('AC1', 'passed', ['T1'])] }));
    expect(item!.cause).toBeNull();
  });

  it('says no task covers a section when none of its criteria has a task', () => {
    expect(gapCause({ acIds: ['AC9'] }, ctx({ evidence: [row('AC1', 'passed', ['T1'])] }))).toEqual({ kind: 'no-task' });
    expect(gapCause({ acIds: [] }, ctx())).toEqual({ kind: 'no-task' });
  });

  it('reports the real block, following dependency blocks back to their root', () => {
    const tasks = new Map([
      ['T1', { state: 'blocked' as const, dependsOn: [] }],
      ['T2', { state: 'blocked' as const, dependsOn: ['T1'] }],
    ]);
    const reasons: Record<string, string> = { T1: 'Dev reported done but produced no changes.', T2: DEPENDENCY_BLOCKED };
    const cause = gapCause({ acIds: ['AC1'] }, ctx({ evidence: [row('AC1', 'blocked', ['T2'])], tasks, reasonOf: (id) => reasons[id]! }));
    expect(cause).toEqual({ kind: 'blocked', roots: [{ taskId: 'T1', reason: 'Dev reported done but produced no changes.' }] });
  });

  it('says tests fail when a criterion of the section has a failing test', () => {
    const tasks = new Map([['T1', { state: 'merged' as const, dependsOn: [] }]]);
    expect(gapCause({ acIds: ['AC1', 'AC2'] }, ctx({ evidence: [row('AC1', 'passed', ['T1']), row('AC2', 'failed', ['T1'])], tasks }))).toEqual({ kind: 'tests-failing', acIds: ['AC2'] });
  });

  it('says the run stopped when it ended without a validation-ready result', () => {
    const tasks = new Map([['T1', { state: 'merged' as const, dependsOn: [] }]]);
    expect(gapCause({ acIds: ['AC1'] }, ctx({ evidence: [row('AC1', 'missing', ['T1'])], tasks, result: 'deploy-failed' }))).toEqual({ kind: 'run-stopped', result: 'deploy-failed' });
  });

  it('says the code was not built when its tasks merged and nothing failed or stopped', () => {
    const tasks = new Map([['T1', { state: 'merged' as const, dependsOn: [] }]]);
    expect(gapCause({ acIds: ['AC1'] }, ctx({ evidence: [row('AC1', 'missing', ['T1'])], tasks }))).toEqual({ kind: 'not-built' });
  });
});

type Agent = (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>;

const HASH = `sha256:${'a'.repeat(64)}`;
const section = (heading: string) => ({ doc: 'briefing.md' as const, heading });
const spec = makeFrozenSpec({
  derivedFrom: {
    backlogKey: 'todos',
    inputHash: HASH,
    docsHash: HASH,
    sources: [section('Create a todo'), section('List todos'), section('Create a todo')].map((s) => ({ ...s, hash: HASH, bodyHash: HASH })),
  },
});
const summary = {} as ResultSummary;
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary });
type Answer = Array<{ heading: string; status?: 'delivered' | 'partial' | 'missing'; missing?: string; acIds?: string[] }>;
const gapItems = (items: Answer) => items.map((i) => ({ doc: 'briefing.md' as const, heading: i.heading, status: i.status ?? 'delivered', evidence: ['server/todos.ts:1'], missing: i.missing ?? '', acIds: i.acIds ?? ['AC-001'] }));
const answer = (items: Answer) => ok({ specHash: HASH, items: gapItems(items) });

function phaseDeps(runAgent: Agent, over: Partial<PhaseDeps> = {}): PhaseDeps {
  return {
    spec,
    project: makeProject(),
    specHash: HASH,
    runAgent: runAgent as PhaseDeps['runAgent'],
    packBase: () => ({ spec, project: makeProject(), specHash: HASH, assumptions: [], budgetTokens: 8000 }),
    ...over,
  } as PhaseDeps;
}

const context = (): GapContext => ({ evidence: [row('AC-001', 'passed', ['T1'])], tasks: new Map([['T1', { state: 'merged' as const, dependsOn: [] }]]), reasonOf: () => 'blocked', result: 'awaiting-validation' });

describe('cited sections', () => {
  it('lists each cited section once, in the order the spec cites them', () => {
    expect(citedSections(spec)).toEqual([section('Create a todo'), section('List todos')]);
  });
});

describe('gap answer validation', () => {
  const cited = citedSections(spec);
  it('accepts one answer per cited section', () => {
    expect(gapErrors(gapItems([{ heading: 'Create a todo' }, { heading: 'List todos' }]), cited, spec)).toEqual([]);
  });
  it('rejects a missing section, an uncited one, an unknown criterion and an open section with no reason', () => {
    const items = gapItems([{ heading: 'Create a todo', status: 'partial', missing: '', acIds: ['AC-404'] }, { heading: 'Delete a todo' }]);
    expect(gapErrors(items, cited, spec)).toEqual([
      'briefing.md › List todos: answered 0 times',
      'briefing.md › Create a todo: unknown criterion AC-404',
      'briefing.md › Create a todo: partial without what is missing',
      'briefing.md › Delete a todo: not a cited section',
    ]);
  });
});

describe('gap check', () => {
  it('judges every cited section and explains each open one', async () => {
    const runAgent = vi.fn<Agent>(async () => answer([{ heading: 'Create a todo' }, { heading: 'List todos', status: 'missing', missing: 'A list screen.', acIds: [] }]));
    const report = await checkGaps(phaseDeps(runAgent), '/wt', context());
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ kind: 'gaps', role: 'test', cwd: '/wt', protectedDirs: ['/wt'] });
    expect(report).toEqual({
      items: [
        { doc: 'briefing.md', heading: 'Create a todo', status: 'delivered', evidence: ['server/todos.ts:1'], missing: '', acIds: ['AC-001'], cause: null },
        { doc: 'briefing.md', heading: 'List todos', status: 'missing', evidence: ['server/todos.ts:1'], missing: 'A list screen.', acIds: [], cause: { kind: 'no-task' } },
      ],
    });
  });

  it('asks once more after a rejected answer, then keeps the second', async () => {
    const answers = [answer([{ heading: 'Create a todo' }]), answer([{ heading: 'Create a todo' }, { heading: 'List todos' }])];
    const runAgent = vi.fn<Agent>(async () => answers.shift()!);
    const report = await checkGaps(phaseDeps(runAgent), '/wt', context());
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ items: [{ heading: 'Create a todo' }, { heading: 'List todos' }] });
  });

  it('reports why it is unavailable when both answers are rejected', async () => {
    const runAgent = vi.fn<Agent>(async () => answer([{ heading: 'Create a todo' }]));
    const report = await checkGaps(phaseDeps(runAgent), '/wt', context());
    expect(report).toEqual({ unavailable: 'gap check rejected: briefing.md › List todos: answered 0 times' });
  });

  it('is unavailable for a services run and for a spec that cites no section', async () => {
    const runAgent = vi.fn<Agent>();
    const services = await checkGaps(phaseDeps(runAgent, { services: { plan: {} as never, repos: [] } }), '/wt', context());
    expect(services).toMatchObject({ unavailable: expect.stringContaining('service repository') });
    const bare = await checkGaps(phaseDeps(runAgent, { spec: makeFrozenSpec() }), '/wt', context());
    expect(bare).toEqual({ unavailable: 'the spec cites no section of the docs' });
    expect(runAgent).not.toHaveBeenCalled();
  });
});
