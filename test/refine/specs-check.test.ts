import { describe, expect, it } from 'vitest';
import { specsIssues } from '../../server/refine/specs-check.js';
import type { BacklogState } from '../../server/refine/state.js';

const criterion = (id: string) => ({ id, given: 'g', when: 'w', then: 't', smoke: true });
const item = (key: string) => ({ key });
const backlog = (specs: Record<string, unknown>, preplans: Record<string, unknown>, keys: string[]): Pick<BacklogState, 'items' | 'specs' | 'preplans'> =>
  ({ items: keys.map(item), specs, preplans }) as never;
const tasks = (...refs: string[][]) => ({ preplan: { tasks: refs.map((criteriaRefs, i) => ({ id: `P${i + 1}`, criteriaRefs })) } });

describe('specsIssues: the plain check of the new work, with no agent', () => {
  it('finds nothing when every criterion has a task and no id repeats', () => {
    const b = backlog({ a: { spec: { acceptanceCriteria: [criterion('AC-1'), criterion('AC-2')] } } }, { a: tasks(['AC-1'], ['AC-2']) }, ['a']);
    expect(specsIssues(b)).toEqual([]);
  });

  it('flags a spec with no criteria and a repeated criterion id, against the objectives check', () => {
    const b = backlog({ a: { spec: { acceptanceCriteria: [criterion('AC-1')] } }, b: { spec: { acceptanceCriteria: [criterion('AC-1')] } }, c: { spec: { acceptanceCriteria: [] } } }, { a: tasks(['AC-1']), b: tasks(['AC-1']), c: tasks() }, ['a', 'b', 'c']);
    expect(specsIssues(b)).toEqual([
      { check: 'po.objectives-verifiable', text: 'b: o critério AC-1 se repete.' },
      { check: 'po.objectives-verifiable', text: 'c: sem critérios de aceite.' },
    ]);
  });

  it('flags a task citing a missing criterion and a criterion no task covers, against the tasks check', () => {
    const b = backlog({ a: { spec: { acceptanceCriteria: [criterion('AC-1'), criterion('AC-2')] } } }, { a: tasks(['AC-1', 'AC-9']) }, ['a']);
    expect(specsIssues(b).map((i) => [i.check, i.text])).toEqual([
      ['sm.tasks-feasible', 'a: a tarefa P1 cita AC-9, que não existe.'],
      ['sm.tasks-feasible', 'a: nenhuma tarefa cobre AC-2.'],
    ]);
  });

  it('skips an item already delivered, but keeps its ids so a new item cannot repeat them', () => {
    const b = backlog({ old: { spec: { status: 'done', acceptanceCriteria: [criterion('AC-1')] } }, fresh: { spec: { acceptanceCriteria: [criterion('AC-1')] } } }, { fresh: tasks(['AC-1']) }, ['old', 'fresh']);
    expect(specsIssues(b)).toEqual([{ check: 'po.objectives-verifiable', text: 'fresh: o critério AC-1 se repete.' }]);
  });
});
