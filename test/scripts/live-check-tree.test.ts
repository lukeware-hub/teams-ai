import { describe, expect, it } from 'vitest';
import { docsPaths, repoPath } from '../../scripts/live-check/tree.mjs';

describe('the files of the documentation repository read from the GitHub tree', () => {
  it('keeps only the files under docs/', () => {
    const tree = {
      truncated: false,
      tree: [
        { path: 'docs', type: 'tree' },
        { path: 'docs/project.md', type: 'blob' },
        { path: 'docs/specify/login-flow/spec.md', type: 'blob' },
        { path: 'docs/sub', type: 'commit' },
        { path: 'README.md', type: 'blob' },
        { path: 'src/docs/project.md', type: 'blob' },
      ],
    };
    expect(docsPaths(tree)).toEqual(['docs/project.md', 'docs/specify/login-flow/spec.md']);
  });

  it('refuses a truncated tree, because it hides files', () => {
    expect(() => docsPaths({ truncated: true, tree: [] })).toThrow(/truncated/);
  });

  it.each([
    ['https://github.com/lukeware-hub/teams-ai-docs.git', 'lukeware-hub/teams-ai-docs'],
    ['https://github.com/lukeware-hub/teams-ai-docs', 'lukeware-hub/teams-ai-docs'],
    ['git@github.com:lukeware-hub/teams-ai-docs.git', 'lukeware-hub/teams-ai-docs'],
  ])('takes the owner and name of %s', (remote, expected) => {
    expect(repoPath(remote)).toBe(expected);
  });

  it('refuses a remote that is not on GitHub', () => {
    expect(() => repoPath('https://example.com/a/b.git')).toThrow(/not a GitHub remote/);
  });
});
