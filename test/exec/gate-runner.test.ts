import { describe, expect, it } from 'vitest';
import type { Gate } from '../../server/contracts/plan.js';
import { Gate as GateSchema } from '../../server/contracts/plan.js';
import { classifyGate, dockerArgs, runGate, runGates, type GateContext, type GateDeps } from '../../server/exec/gate-runner.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const ctx: GateContext = {
  worktree: '/home/u/ws/worktrees/T1-create',
  image: 'node:22-bookworm',
  junitPath: 'reports/junit.xml',
  cpus: 2,
  memory: '2g',
  timeoutMs: 600_000,
  secrets: { NPM_TOKEN: 'npm_x', DATABASE_URL: 'postgres://x' },
  containerName: 'gate-T1-create-a1',
  user: '1000:1000',
};
const gate = (over: Partial<Gate> & { name: string; command: string }): Gate => GateSchema.parse({ blocking: true, ...over });
const JUNIT = '<testsuite name="s"><testcase classname="c" name="[AC-001] ok"/><testcase classname="c" name="[AC-002] bad"><failure/></testcase></testsuite>';

function files(map: Record<string, string>) {
  const store = new Map(Object.entries(map));
  const removed: string[] = [];
  const deps: Pick<GateDeps, 'readFile' | 'removeFile'> = {
    readFile: async (p) => store.get(p.replace(/\\/g, '/')) ?? null,
    removeFile: async (p) => {
      removed.push(p.replace(/\\/g, '/'));
      store.delete(p.replace(/\\/g, '/'));
    },
  };
  return { deps, store, removed };
}

describe('dockerArgs', () => {
  it('keeps the image PATH (no login shell) and points the toolchain caches into the mounted worktree', () => {
    const { args } = dockerArgs(gate({ name: 'lint', command: 'go vet ./...' }), ctx);
    expect(args.slice(-3)).toEqual(['sh', '-c', 'go vet ./...']);
    expect(args).toEqual(expect.arrayContaining(['GOPATH=/work/.tools/go', 'GOCACHE=/work/.tools/go-build', 'CARGO_HOME=/work/.tools/cargo', 'PYTHONPATH=/work/.tools/py']));
  });

  it('runs the command offline in a named, init-managed, non-root container with limits and read-only .git', () => {
    const { args, env } = dockerArgs(gate({ name: 'unit-test', command: 'npm test' }), ctx);
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--name', 'gate-T1-create-a1-unit-test',
        '--network', 'none',
        '--cpus', '2',
        '--memory', '2g',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', '512',
        '--user', '1000:1000',
        '-e', 'HOME=/tmp',
        '--mount', `type=bind,source=${ctx.worktree},target=/work`,
        '--mount', `type=bind,source=${ctx.worktree}/.git,target=/work/.git,readonly`,
        '-w', '/work',
        'node:22-bookworm',
      ]),
    );
    expect(args.slice(-3)).toEqual(['sh', '-c', 'npm test']);
    expect(args.join(' ')).not.toContain('npm_x');
    expect(env).toEqual({});
  });

  it('gives egress gates a bridge network and passes declared secrets by name, values through the environment', () => {
    const { args, env } = dockerArgs(gate({ name: 'install', command: 'npm ci', network: 'egress', secrets: ['NPM_TOKEN'] }), ctx);
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
    expect(args).toEqual(expect.arrayContaining(['-e', 'NPM_TOKEN']));
    expect(args.join(' ')).not.toContain('npm_x');
    expect(env).toEqual({ NPM_TOKEN: 'npm_x' });
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('mounts the shared cache only into the prescribed security gates, through the bind rewrite', () => {
    const cached = { ...ctx, cacheDir: '/home/node/.teams-ai/gate-cache', bindRewrite: { from: '/home/node/.teams-ai', to: '/var/lib/docker/volumes/data/_data' } };
    for (const name of ['security-tools', 'image-scan']) {
      const { args } = dockerArgs(gate({ name, command: 'x', network: 'egress' }), cached);
      expect(args).toEqual(expect.arrayContaining(['--mount', 'type=bind,source=/var/lib/docker/volumes/data/_data/gate-cache,target=/gate-cache', '-e', 'TEAMS_AI_GATE_CACHE=/gate-cache', '-e', 'TRIVY_CACHE_DIR=/gate-cache/trivy', '-e', 'PIP_CACHE_DIR=/gate-cache/pip']));
    }
    for (const name of ['unit-test', 'build', 'sast']) expect(dockerArgs(gate({ name, command: 'x' }), cached).args.join(' ')).not.toContain('gate-cache');
    expect(dockerArgs(gate({ name: 'image-scan', command: 'x' }), ctx).args.join(' ')).not.toContain('gate-cache');
  });

  it('fails loudly when a declared secret is missing', () => {
    expect(() => dockerArgs(gate({ name: 'x', command: 'y', secrets: ['MISSING'] }), ctx)).toThrow(/MISSING/);
  });

  it('omits --user when no user is configured', () => {
    const { args } = dockerArgs(gate({ name: 'x', command: 'y' }), { ...ctx, user: undefined });
    expect(args).not.toContain('--user');
  });
});

describe('classifyGate', () => {
  it('treats OOM kills, daemon errors, disk full and timeouts as infra', () => {
    expect(classifyGate({ exitCode: 137, timedOut: false, stderrTail: '' })).toBe('infra');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' })).toBe('infra');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: 'write /work/x: no space left on device' })).toBe('infra');
    expect(classifyGate({ exitCode: null, timedOut: true, stderrTail: '' })).toBe('code');
  });

  it('does not mistake a test\'s own ENOENT or heap message for infra', () => {
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: "Error: ENOENT: no such file or directory, open 'fixtures/x.json'" })).toBe('code');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: 'FATAL ERROR: JavaScript heap out of memory' })).toBe('code');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: '3 tests failed' })).toBe('code');
  });
});

describe('runGate', () => {
  it('redacts secret values from the output tails', async () => {
    const f = files({});
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 1, stderr: 'auth failed for postgres://x with token npm_x' }));
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, ...f.deps });
    expect(r.stderrTail).not.toContain('npm_x');
    expect(r.stderrTail).not.toContain('postgres://x');
    expect(r.stderrTail).toContain('[REDACTED]');
  });

  it('passes on exit 0, removes a stale report first and picks up the fresh JUnit report', async () => {
    const report = '/home/u/ws/worktrees/T1-create/reports/junit.xml';
    const f = files({ [report]: '<testsuite name="stale"><testcase classname="c" name="[AC-009] stale"/></testsuite>' });
    const fake = new FakeExec().onArgs('docker', ['run'], () => {
      f.store.set(report, JUNIT); // the gate writes a fresh report
      return { stdout: 'ok' };
    });
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, ...f.deps });
    expect(f.removed).toEqual([report]);
    expect(r).toMatchObject({ name: 'unit-test', passed: true, exitCode: 0, failure: null });
    expect(r.junit).toHaveLength(2);
    expect(r.junit![1]!.status).toBe('failed');
    const run = fake.calls.find((c) => c.args[0] === 'run')!;
    expect(run.env).toEqual({});
  });

  it('reports a code failure with the tail of the output when the command exits non-zero', async () => {
    const f = files({});
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 1, stdout: 'x'.repeat(10_000) + 'THE END', stderr: 'FAIL src/a.test.ts' }));
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, ...f.deps });
    expect(r.passed).toBe(false);
    expect(r.failure).toBe('code');
    expect(r.stdoutTail.length).toBe(4000);
    expect(r.stdoutTail.endsWith('THE END')).toBe(true);
    expect(r.junit).toBeNull();
  });

  it('reports infra when the container is OOM-killed', async () => {
    const f = files({});
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 137 }));
    const r = await runGate(gate({ name: 'build', command: 'npm run build' }), ctx, { exec: fake.exec, ...f.deps });
    expect(r.failure).toBe('infra');
  });

  it('force-removes the named container after a timeout so nothing keeps running', async () => {
    const f = files({});
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: null, timedOut: true }));
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, ...f.deps });
    expect(r.failure).toBe('code');
    expect(fake.lines('docker')).toContain('rm -f gate-T1-create-a1-unit-test');
  });

  it('reports infra when docker itself cannot be spawned', async () => {
    const f = files({});
    const r = await runGate(gate({ name: 'build', command: 'npm run build' }), ctx, {
      exec: async () => {
        throw new Error('cannot run docker: spawn docker ENOENT');
      },
      ...f.deps,
    });
    expect(r).toMatchObject({ passed: false, failure: 'infra' });
    expect(r.stderrTail).toMatch(/ENOENT/);
  });

  it('rejects a junitPath that escapes the worktree', async () => {
    const f = files({});
    const fake = new FakeExec();
    await expect(runGate(gate({ name: 'unit-test', command: 'npm test' }), { ...ctx, junitPath: '../outside.xml' }, { exec: fake.exec, ...f.deps })).rejects.toThrow(/junitPath/);
  });

  describe('the coverage gate (roadmap R10.2)', () => {
    const covCtx: GateContext = { ...ctx, coveragePath: 'reports/coverage-summary.json' };
    const covPath = '/home/u/ws/worktrees/T1-create/reports/coverage-summary.json';

    it('passes when the command exits 0 and the written summary clears the floor', async () => {
      const f = files({ [covPath]: '{"linesPct": 83.4}' });
      const fake = new FakeExec().onArgs('docker', ['run'], () => ({ stdout: 'ok' }));
      const r = await runGate(gate({ name: 'coverage', command: 'npx vitest run --coverage' }), covCtx, { exec: fake.exec, ...f.deps });
      expect(r).toMatchObject({ passed: true, failure: null });
    });

    it('fails even on exit 0 when the summary is below the floor', async () => {
      const f = files({ [covPath]: '{"linesPct": 79.9}' });
      const fake = new FakeExec().onArgs('docker', ['run'], () => ({ stdout: 'ok' }));
      const r = await runGate(gate({ name: 'coverage', command: 'npx vitest run --coverage' }), covCtx, { exec: fake.exec, ...f.deps });
      expect(r).toMatchObject({ passed: false, failure: 'code' });
    });

    it('fails closed when the command exits 0 but never wrote the summary (a disarmed or broken command cannot pass this way)', async () => {
      const f = files({});
      const fake = new FakeExec().onArgs('docker', ['run'], () => ({ stdout: 'ok' }));
      const r = await runGate(gate({ name: 'coverage', command: 'npx vitest run --coverage || true' }), covCtx, { exec: fake.exec, ...f.deps });
      expect(r).toMatchObject({ passed: false, failure: 'code' });
    });

    it('fails closed when the summary is malformed', async () => {
      const f = files({ [covPath]: 'not json' });
      const fake = new FakeExec().onArgs('docker', ['run'], () => ({ stdout: 'ok' }));
      const r = await runGate(gate({ name: 'coverage', command: 'npx vitest run --coverage' }), covCtx, { exec: fake.exec, ...f.deps });
      expect(r).toMatchObject({ passed: false, failure: 'code' });
    });

    it('fails closed when coveragePath was never set on the context', async () => {
      const f = files({});
      const fake = new FakeExec().onArgs('docker', ['run'], () => ({ stdout: 'ok' }));
      const r = await runGate(gate({ name: 'coverage', command: 'npx vitest run --coverage' }), ctx, { exec: fake.exec, ...f.deps });
      expect(r).toMatchObject({ passed: false, failure: 'code' });
    });

    it('never applies the coverage check to a gate with a different name', async () => {
      const f = files({});
      const fake = new FakeExec().onArgs('docker', ['run'], () => ({ stdout: 'ok' }));
      const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), covCtx, { exec: fake.exec, ...f.deps });
      expect(r).toMatchObject({ passed: true, failure: null });
    });

    it('rejects a coveragePath that escapes the worktree', async () => {
      const f = files({});
      const fake = new FakeExec();
      await expect(
        runGate(gate({ name: 'coverage', command: 'npx vitest run --coverage' }), { ...covCtx, coveragePath: '../outside.json' }, { exec: fake.exec, ...f.deps }),
      ).rejects.toThrow(/coveragePath/);
    });
  });
});

describe('runGates', () => {
  const gates = [
    gate({ name: 'lint', command: 'npm run lint' }),
    gate({ name: 'unit-test', command: 'npm test' }),
    gate({ name: 'dependency-scan', command: 'osv-scanner .', blocking: false, network: 'egress' }),
    gate({ name: 'build', command: 'npm run build' }),
  ];

  it('stops at the first blocking failure and skips the rest', async () => {
    const f = files({});
    const fake = new FakeExec().on((s) => s.args.includes('npm test'), () => ({ exitCode: 1, stderr: 'boom' }));
    const out = await runGates(gates, ctx, { exec: fake.exec, ...f.deps });
    expect(out.results.map((r) => r.name)).toEqual(['lint', 'unit-test']);
    expect(out.blockingFailure?.name).toBe('unit-test');
  });

  it('runs every gate when only a non-blocking one fails', async () => {
    const f = files({});
    const fake = new FakeExec().on((s) => s.args.includes('osv-scanner .'), () => ({ exitCode: 2, stdout: 'vuln' }));
    const out = await runGates(gates, ctx, { exec: fake.exec, ...f.deps });
    expect(out.results.map((r) => r.passed)).toEqual([true, true, false, true]);
    expect(out.blockingFailure).toBeNull();
  });

  it('leaves the last JUnit report in the worktree after the run (reviewers read it)', async () => {
    // Every gate removes the report before it runs; only unit-test writes one. Without restoring it
    // the reviewer finds no test evidence (live-run finding).
    const f = files({});
    const report = `${ctx.worktree}/${ctx.junitPath}`.replace(/\\/g, '/');
    const fake = new FakeExec().on(
      (s) => s.args.includes('npm test'),
      () => {
        f.store.set(report, '<testsuite name="s"><testcase classname="s" name="[AC-001] ok"/></testsuite>');
        return { exitCode: 0 };
      },
    );
    const written: Array<[string, string]> = [];
    const out = await runGates(gates, ctx, { exec: fake.exec, ...f.deps, writeFile: async (p, text) => void written.push([p.replace(/\\/g, '/'), text]) });
    expect(out.blockingFailure).toBeNull();
    expect(out.results[1]!.junit?.map((t) => t.id)).toEqual(['s::[AC-001] ok']);
    expect(written).toEqual([[report, '<testsuite name="s"><testcase classname="s" name="[AC-001] ok"/></testsuite>']]);
  });
});

describe('rewriteBindSource', () => {
  it('maps a worktree under the orchestrator root onto the daemon-side root, and leaves other paths alone', async () => {
    const { rewriteBindSource } = await import('../../server/exec/gate-runner.js');
    const rewrite = { from: '/root/.teams-ai', to: '/var/lib/docker/volumes/teams-ai-config/_data' };
    expect(rewriteBindSource('/root/.teams-ai/workspaces/p/worktrees/t', rewrite)).toBe('/var/lib/docker/volumes/teams-ai-config/_data/workspaces/p/worktrees/t');
    expect(rewriteBindSource('/root/.teams-ai', rewrite)).toBe('/var/lib/docker/volumes/teams-ai-config/_data');
    expect(rewriteBindSource('/root/.teams-ai-other/x', rewrite)).toBe('/root/.teams-ai-other/x');
    expect(rewriteBindSource('/root/.teams-ai/x', undefined)).toBe('/root/.teams-ai/x');
  });
  it('egress gates can reach the host daemon published ports through host.docker.internal; offline gates cannot', () => {
    const egress = dockerArgs(gate({ name: 'smoke', command: 'x', network: 'egress' }), ctx).args;
    expect(egress[egress.indexOf('--add-host') + 1]).toBe('host.docker.internal:host-gateway');
    expect(dockerArgs(gate({ name: 'x', command: 'y' }), ctx).args).not.toContain('--add-host');
  });

  it('dockerArgs binds the rewritten source for both the worktree and its .git', () => {
    const { args } = dockerArgs(gate({ name: 'unit-test', command: 'npm test' }), { ...ctx, bindRewrite: { from: '/home/u/ws', to: '/vol/ws' } });
    expect(args).toContain('type=bind,source=/vol/ws/worktrees/T1-create,target=/work');
    expect(args).toContain('type=bind,source=/vol/ws/worktrees/T1-create/.git,target=/work/.git,readonly');
  });
});
