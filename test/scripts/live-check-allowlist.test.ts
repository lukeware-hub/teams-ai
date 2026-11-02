import { describe, expect, it } from 'vitest';
import { disallowedFiles, isEightKind } from '../../scripts/live-check/allowlist.mjs';

describe('the allowlist of the documentation repository', () => {
  it.each([
    'docs/project.md',
    'docs/flow.md',
    'docs/briefing.md',
    'docs/design.md',
    'docs/stack.md',
    'docs/specify/login-flow/spec.md',
    'docs/specify/login-flow/plan.md',
    'docs/specify/login-flow/task.md',
    'docs/shop-api/specify/login-flow/spec.md',
    'docs/shop-web/specify/login-flow/task.md',
    `docs/specify/${'a'.repeat(40)}/spec.md`,
  ])('accepts %s', (rel) => {
    expect(isEightKind(rel)).toBe(true);
  });

  it.each([
    'docs/project.json',
    'docs/specs.json',
    'docs/backlog.md',
    'docs/architecture.md',
    'docs/README.md',
    'docs/tech-spec.md',
    'docs/specify/login-flow/spec.json',
    'docs/specify/login-flow/preplan.json',
    'docs/specify/login-flow/plan.json',
    'docs/specify/login-flow/implementation-plan.md',
    'docs/specify/login-flow/extra/spec.md',
    'docs/specify/login--flow/spec.md',
    'docs/specify/-login/spec.md',
    'docs/specify/Login/spec.md',
    `docs/specify/${'a'.repeat(41)}/spec.md`,
    'docs/specify/con/spec.md',
    'docs/specify/com1/plan.md',
    'docs/web/specify/login-flow/spec.md',
    'docs/shop-cache/specify/login-flow/spec.md',
    'README.md',
    'src/docs/project.md',
  ])('refuses %s', (rel) => {
    expect(isEightKind(rel)).toBe(false);
  });

  it('lists only the refused files of a list', () => {
    expect(disallowedFiles(['docs/project.md', 'docs/specs.json', 'docs/specify/login-flow/plan.md'])).toEqual(['docs/specs.json']);
  });
});
