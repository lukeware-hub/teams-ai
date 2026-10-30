import { describe, expect, it } from 'vitest';
import { blobUrl, githubRepoUrl } from '../../server/api/run-routes.js';

describe('githubRepoUrl', () => {
  it('normalizes https and ssh GitHub remotes to a browsable URL', () => {
    expect(githubRepoUrl('https://github.com/acme/demo.git\n')).toBe('https://github.com/acme/demo');
    expect(githubRepoUrl('https://x-access-token:abc@github.com/acme/demo')).toBe('https://github.com/acme/demo');
    expect(githubRepoUrl('git@github.com:acme/demo.git')).toBe('https://github.com/acme/demo');
    expect(githubRepoUrl('ssh://git@github.com/acme/demo.git')).toBe('https://github.com/acme/demo');
  });
  it('returns null for other hosts', () => {
    expect(githubRepoUrl('https://gitlab.com/acme/demo.git')).toBeNull();
    expect(githubRepoUrl('/local/path/repo')).toBeNull();
  });
});

describe('blobUrl', () => {
  const commit = 'a'.repeat(40);
  it('links one line of a file at a commit, encoding each part of the path', () => {
    expect(blobUrl('https://github.com/acme/demo', commit, 'a b/c#d.go', 7)).toBe(`https://github.com/acme/demo/blob/${commit}/a%20b/c%23d.go#L7`);
    expect(blobUrl('https://github.com/acme/demo', commit, 'relatório/x.ts', 1)).toBe(`https://github.com/acme/demo/blob/${commit}/relat%C3%B3rio/x.ts#L1`);
  });
  it('gives no link for a repository, commit or line that does not look right', () => {
    expect(blobUrl('https://github.com/acme/demo?x=1', commit, 'a.go', 1)).toBeNull();
    expect(blobUrl('https://gitlab.com/acme/demo', commit, 'a.go', 1)).toBeNull();
    expect(blobUrl('https://github.com/acme/demo', 'main', 'a.go', 1)).toBeNull();
    expect(blobUrl('https://github.com/acme/demo', commit, 'a.go', 0)).toBeNull();
    expect(blobUrl('https://github.com/acme/demo', commit, 'a.go', 1.5)).toBeNull();
  });
});
