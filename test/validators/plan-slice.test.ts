import { describe, expect, it } from 'vitest';
import { validatePlan } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlan, makePlanTask } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const base = makePlan(spec);
const withTask = (task: ReturnType<typeof makePlanTask>) => ({ ...base, tasks: [...base.tasks, task] });
const sliced = { firstSpec: true, sliceCeiling: true };

describe('feature tasks per criterion (sliceCeiling)', () => {
  it('accepts one feature task per criterion', () => {
    expect(validatePlan(base, spec, sliced)).toEqual([]);
  });

  it('rejects more feature tasks than criteria and names the tasks that share a criterion', () => {
    const plan = withTask(makePlanTask({ id: 'T4-extra', criteriaRefs: ['AC-001'], dependsOn: ['T0-scaffold'] }));
    expect(validatePlan(plan, spec, sliced)).toEqual(
      expect.arrayContaining([expect.stringContaining('3 feature tasks for 2 acceptance criteria (at most 2); merge the tasks that share a criterion: AC-001 by T1-create, T4-extra')]),
    );
  });

  it('does not count devops, scaffold or orchestrator fix tasks', () => {
    const plan = withTask(makePlanTask({ id: 'T900-fix-1', origin: 'fix', criteriaRefs: ['AC-001'], dependsOn: ['T0-scaffold'] }));
    expect(validatePlan(plan, spec, sliced)).toEqual([]);
  });

  it('stays off unless the plan step asks for it, so a fix revalidation keeps an older plan valid', () => {
    const plan = withTask(makePlanTask({ id: 'T4-extra', criteriaRefs: ['AC-001'], dependsOn: ['T0-scaffold'] }));
    expect(validatePlan(plan, spec, { firstSpec: true })).toEqual([]);
  });
});
