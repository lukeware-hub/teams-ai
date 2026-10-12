import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STACK_BASH, UNCOMMITTED_BUILD_DIRS, copyCargoRoot, stackDomains, stackEnv } from '../../server/runner/stacks.js';

describe('stacks', () => {
  it('reaches only the registries of the run stack, plus npm', () => {
    expect(stackDomains('go', null)).toEqual(['registry.npmjs.org', 'proxy.golang.org', 'sum.golang.org']);
    // Behind the platform's module proxy a Go step reaches only it and the checksum database, never storage.googleapis.com,
    // where proxy.golang.org redirects larger zips (any bucket there would be a way out for data).
    expect(stackDomains('go', 'http://goproxy:8080')).toEqual(['registry.npmjs.org', 'goproxy', 'sum.golang.org']);
    expect(stackDomains('node', 'http://goproxy:8080')).toEqual(['registry.npmjs.org']);
    expect(stackDomains('other')).toEqual(['registry.npmjs.org']);
    expect(stackDomains('python')).not.toContain('crates.io');
  });

  it('still scans the committed Go vendor folder for secrets', () => {
    expect(UNCOMMITTED_BUILD_DIRS).not.toContain('vendor');
    expect(UNCOMMITTED_BUILD_DIRS).toContain('node_modules');
    expect(UNCOMMITTED_BUILD_DIRS).toContain('.next');
  });

  it('allows the toolchain commands of Go, Rust and Python', () => {
    expect(STACK_BASH).toEqual(expect.arrayContaining(['Bash(go:*)', 'Bash(cargo:*)', 'Bash(python3:*)']));
    // Live: a Go Dev blocked its task because gofmt and the plan's own test command (.tools/bin/gotestsum) were refused.
    expect(STACK_BASH).toEqual(expect.arrayContaining(['Bash(gofmt:*)', 'Bash(.tools/bin/gotestsum:*)']));
  });

  it('keeps every cache inside the worktree', () => {
    const env = stackEnv('/w/t1');
    for (const key of ['GOPATH', 'GOCACHE', 'CARGO_HOME', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX', 'PYTHONPATH']) expect(env[key]).toMatch(/^\/w\/t1\/\.tools\//);
  });

  it('copies the binaries and records cargo install leaves, so a seeded root sees the tools installed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-cargo-'));
    const cache = path.join(root, 'cache');
    await fs.mkdir(path.join(cache, 'bin'), { recursive: true });
    await fs.writeFile(path.join(cache, 'bin', 'cargo-nextest'), 'bin');
    await fs.writeFile(path.join(cache, '.crates2.json'), '{"installs":{}}');
    await copyCargoRoot(cache, path.join(root, 'wt', '.tools'));
    expect(await fs.readFile(path.join(root, 'wt', '.tools', 'bin', 'cargo-nextest'), 'utf8')).toBe('bin');
    expect(await fs.readFile(path.join(root, 'wt', '.tools', '.crates2.json'), 'utf8')).toBe('{"installs":{}}');
    // A symlink planted in the agent-writable root is never copied, nor written through at the destination.
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'host');
    await fs.symlink(outside, path.join(root, 'wt', '.tools', 'bin', 'evil'));
    await fs.symlink(outside, path.join(cache, 'bin', 'cargo-deny'));
    await copyCargoRoot(path.join(root, 'wt', '.tools'), cache);
    expect((await fs.lstat(path.join(cache, 'bin', 'evil')).catch(() => null))).toBeNull();
    expect(await fs.readFile(outside, 'utf8')).toBe('host');
    await copyCargoRoot(path.join(root, 'missing'), path.join(root, 'wt2'));
    await expect(fs.access(path.join(root, 'wt2'))).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});
