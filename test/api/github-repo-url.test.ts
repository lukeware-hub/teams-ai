import { describe, expect, it } from 'vitest';
import { githubRepoUrl } from '../../server/api/run-routes.js';

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
