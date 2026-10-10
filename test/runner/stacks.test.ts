import { describe, expect, it } from 'vitest';
import { STACK_BASH, UNCOMMITTED_BUILD_DIRS, stackDomains, stackEnv } from '../../server/runner/stacks.js';

describe('stacks', () => {
  it('reaches only the registries of the run stack, plus npm', () => {
    expect(stackDomains('go')).toEqual(['registry.npmjs.org', 'proxy.golang.org', 'sum.golang.org']);
    expect(stackDomains('node')).toEqual(['registry.npmjs.org']);
    expect(stackDomains('other')).toEqual(['registry.npmjs.org']);
    expect(stackDomains('python')).not.toContain('crates.io');
  });

  it('still scans the committed Go vendor folder for secrets', () => {
    expect(UNCOMMITTED_BUILD_DIRS).not.toContain('vendor');
    expect(UNCOMMITTED_BUILD_DIRS).toContain('node_modules');
  });

  it('allows the toolchain commands of Go, Rust and Python', () => {
    expect(STACK_BASH).toEqual(expect.arrayContaining(['Bash(go:*)', 'Bash(cargo:*)', 'Bash(python3:*)']));
  });

  it('keeps every cache inside the worktree', () => {
    const env = stackEnv('/w/t1');
    for (const key of ['GOPATH', 'GOCACHE', 'CARGO_HOME', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX', 'PYTHONPATH']) expect(env[key]).toMatch(/^\/w\/t1\/\.tools\//);
  });
});
