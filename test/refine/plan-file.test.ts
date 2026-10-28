import { describe, expect, it } from 'vitest';
import { planFileOf, specSectionOf } from '../../server/refine/plan-file.js';
import { specIdOf } from '../../server/refine/specs-index.js';

describe('planFileOf', () => {
  it('names the plan of a spec whose id is its key alone', () => {
    expect(planFileOf(specIdOf('draft-one', 'user-login', true))).toBe('docs/specs/user-login/implementation-plan.md');
  });

  it('names the plan of a spec whose id keeps the older draft form', () => {
    expect(planFileOf(specIdOf('draft-one', 'user-login'))).toBe('docs/specs/draft-one-user-login/implementation-plan.md');
  });
});

describe('specSectionOf', () => {
  const specsMd = ['# Specs', '', '## login: Sign in', 'Criteria of login.', '', '## cart: Cart', 'Criteria of cart.'].join('\n');

  it('returns the section of the item, up to the next level-two heading', () => {
    expect(specSectionOf(specsMd, 'login')).toBe('## login: Sign in\nCriteria of login.\n');
  });

  it('returns the last section up to the end of the text', () => {
    expect(specSectionOf(specsMd, 'cart')).toBe('## cart: Cart\nCriteria of cart.');
  });

  it('returns nothing for an item the text does not have', () => {
    expect(specSectionOf(specsMd, 'missing')).toBe('');
  });
});
