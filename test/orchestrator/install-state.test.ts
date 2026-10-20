import { describe, expect, it } from 'vitest';
import { needsInstall } from '../../server/orchestrator/install-state.js';

describe('needsInstall', () => {
  it('installs when no dependency directory is present', () => {
    expect(needsInstall(false, null, 'abc')).toBe(true);
  });

  it('skips the install when the dependencies were installed for this commit', () => {
    expect(needsInstall(true, 'abc', 'abc')).toBe(false);
  });

  it('installs again after a rebase moved the worktree to another commit', () => {
    expect(needsInstall(true, 'abc', 'def')).toBe(true);
  });

  it('installs when a dependency directory has no record of its commit yet', () => {
    expect(needsInstall(true, null, 'abc')).toBe(true);
  });
});
