import { describe, expect, it } from 'vitest';
import { planFileOf } from '../../server/refine/plan-file.js';
import { specIdOf } from '../../server/refine/specs-index.js';

describe('planFileOf', () => {
  it('names the plan of a spec whose id is its key alone', () => {
    expect(planFileOf(specIdOf('draft-one', 'user-login', true))).toBe('docs/specs/user-login/implementation-plan.md');
  });

  it('names the plan of a spec whose id keeps the older draft form', () => {
    expect(planFileOf(specIdOf('draft-one', 'user-login'))).toBe('docs/specs/draft-one-user-login/implementation-plan.md');
  });
});
