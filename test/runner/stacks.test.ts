import { describe, expect, it } from 'vitest';
import { STACK_BASH, STACK_DOMAINS, stackEnv } from '../../server/runner/stacks.js';

describe('stacks', () => {
  it('reaches the registries of Node.js, Python, Go and Rust', () => {
    expect(STACK_DOMAINS).toEqual(expect.arrayContaining(['registry.npmjs.org', 'pypi.org', 'proxy.golang.org', 'crates.io']));
  });

  it('allows the toolchain commands of Go, Rust and Python', () => {
    expect(STACK_BASH).toEqual(expect.arrayContaining(['Bash(go:*)', 'Bash(cargo:*)', 'Bash(python3:*)']));
  });

  it('keeps every cache inside the worktree', () => {
    const env = stackEnv('/w/t1');
    for (const key of ['GOPATH', 'GOCACHE', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX', 'PYTHONPATH']) expect(env[key]).toMatch(/^\/w\/t1\/\.tools\//);
  });
});
