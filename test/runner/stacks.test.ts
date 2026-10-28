import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STACK_BASH, UNCOMMITTED_BUILD_DIRS, copyCargoRoot, stackBash, stackDomains, stackEnv, stackKind } from '../../server/runner/stacks.js';

describe('stacks', () => {
  it('reaches only the registries of the run stack, and npm only from a node stack', () => {
    expect(stackDomains('go', null)).toEqual(['proxy.golang.org', 'sum.golang.org', 'osv.dev', 'api.osv.dev', 'vuln.go.dev']);
    // Behind the platform's module proxy a Go step reaches only it and the checksum database, never storage.googleapis.com,
    // where proxy.golang.org redirects larger zips (any bucket there would be a way out for data).
    expect(stackDomains('go', 'http://goproxy:8080')).toEqual(['goproxy', 'sum.golang.org', 'osv.dev', 'api.osv.dev', 'vuln.go.dev']);
    expect(stackDomains('node', 'http://goproxy:8080')).toEqual(['registry.npmjs.org', 'osv.dev', 'api.osv.dev']);
    expect(stackDomains('other')).toEqual(['osv.dev', 'api.osv.dev']);
    expect(stackDomains('python')).not.toContain('crates.io');
    expect(stackDomains('python')).not.toContain('registry.npmjs.org');
    expect(stackDomains('rust')).not.toContain('registry.npmjs.org');
  });

  it('opens the Maven and Gradle repositories to a Java stack only', () => {
    expect(stackDomains('java', null)).toEqual(expect.arrayContaining(['repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org']));
    expect(stackDomains('java', null)).not.toContain('registry.npmjs.org');
    expect(stackDomains('node', null)).not.toContain('repo1.maven.org');
  });

  it('still scans the committed Go vendor folder for secrets', () => {
    expect(UNCOMMITTED_BUILD_DIRS).not.toContain('vendor');
    expect(UNCOMMITTED_BUILD_DIRS).toContain('node_modules');
    expect(UNCOMMITTED_BUILD_DIRS).toContain('.next');
  });

  it('gives each stack only its own toolchain commands', () => {
    // Live: a Go Dev blocked its task because gofmt and the plan's own test command (.tools/bin/gotestsum) were refused.
    expect(STACK_BASH.go).toEqual(expect.arrayContaining(['Bash(go:*)', 'Bash(gofmt:*)', 'Bash(.tools/bin/gotestsum:*)']));
    expect(STACK_BASH.rust).toEqual(['Bash(cargo:*)', 'Bash(rustc:*)']);
    expect(STACK_BASH.python).toEqual(expect.arrayContaining(['Bash(python3:*)', 'Bash(.tools/venv/bin/pip:*)']));
    expect(STACK_BASH.java).toEqual(expect.arrayContaining(['Bash(mvn:*)', 'Bash(./gradlew:*)']));
    expect(STACK_BASH.node).toEqual(expect.arrayContaining(['Bash(npm:*)', 'Bash(npx:*)']));
    expect(STACK_BASH.dotnet).toEqual(['Bash(dotnet:*)']);
    for (const kind of ['python', 'go', 'rust', 'java', 'dotnet', 'flutter', 'other'] as const) expect(STACK_BASH[kind].join(' ')).not.toMatch(/npm|npx/);
    expect(stackBash(['python', 'python'])).toEqual(STACK_BASH.python);
    expect(stackBash([])).toEqual([]);
  });

  it('keeps every cache inside the worktree', () => {
    const env = stackEnv('/w/t1');
    for (const key of ['GOPATH', 'GOCACHE', 'CARGO_HOME', 'PIP_CACHE_DIR', 'PYTHONPYCACHEPREFIX', 'PYTHONPATH', 'BUF_CACHE_DIR', 'XDG_CACHE_HOME', 'PUB_CACHE', 'GRADLE_USER_HOME']) expect(env[key]).toMatch(/^\/w\/t1\/\.tools\//);
    expect(env.MAVEN_OPTS).toBe('-Dmaven.repo.local=/w/t1/.tools/m2');
  });

  it('classifies a Java stack by its build tool or runtime, and keeps Node names apart', () => {
    expect(stackKind('java-spring')).toBe('java');
    expect(stackKind('Spring Boot 3 with Maven, eclipse-temurin:21')).toBe('java');
    expect(stackKind('gradle 8 on jdk 21')).toBe('java');
    expect(stackKind('ASP.NET Core 8 minimal API')).toBe('dotnet');
    expect(stackKind('C# worker, dotnet 8')).toBe('dotnet');
    expect(stackKind('mcr.microsoft.com/dotnet/sdk:8.0')).toBe('dotnet');
    expect(stackKind('React SPA with Vite')).toBe('node');
    expect(stackKind('Vue 3 frontend')).toBe('node');
  });

  it('reads a Flutter project as the flutter stack, even on a node gate image', () => {
    expect(stackKind('Flutter app, Android only')).toBe('flutter');
    expect(stackKind('dart 3 package')).toBe('flutter');
    expect(stackKind('Flutter app node:22-bookworm')).toBe('flutter');
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
