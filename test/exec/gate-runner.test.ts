import { describe, expect, it } from 'vitest';
import type { Gate } from '../../server/contracts/plan.js';
import { Gate as GateSchema } from '../../server/contracts/plan.js';
import { classifyGate, dockerArgs, runGate, runGates, type GateContext } from '../../server/exec/gate-runner.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const ctx: GateContext = {
  worktree: '/home/u/ws/worktrees/T1-create',
  image: 'node:22-bookworm',
  junitPath: 'reports/junit.xml',
  cpus: 2,
  memory: '2g',
  timeoutMs: 600_000,
  secrets: { NPM_TOKEN: 'npm_x', DATABASE_URL: 'postgres://x' },
};
const gate = (over: Partial<Gate> & { name: string; command: string }): Gate => GateSchema.parse({ blocking: true, ...over });
const JUNIT = '<testsuite name="s"><testcase classname="c" name="[AC-001] ok"/><testcase classname="c" name="[AC-002] bad"><failure/></testcase></testsuite>';
const files = (map: Record<string, string>) => async (p: string) => map[p.replace(/\\/g, '/')] ?? null;

describe('dockerArgs', () => {
  it('runs the command offline in a disposable container with limits and the worktree mounted', () => {
    const args = dockerArgs(gate({ name: 'unit-test', command: 'npm test' }), ctx);
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--cpus', '2', '--memory', '2g', '-v', `${ctx.worktree}:/work`, '-w', '/work', 'node:22-bookworm']));
    expect(args.slice(-3)).toEqual(['sh', '-lc', 'npm test']);
    expect(args.join(' ')).not.toContain('npm_x');
  });

  it('gives egress gates a bridge network and injects only the declared secrets', () => {
    const args = dockerArgs(gate({ name: 'install', command: 'npm ci', network: 'egress', secrets: ['NPM_TOKEN'] }), ctx);
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
    expect(args).toEqual(expect.arrayContaining(['-e', 'NPM_TOKEN=npm_x']));
    expect(args.join(' ')).not.toContain('DATABASE_URL');
  });

  it('fails loudly when a declared secret is missing', () => {
    expect(() => dockerArgs(gate({ name: 'x', command: 'y', secrets: ['MISSING'] }), ctx)).toThrow(/MISSING/);
  });
});

describe('classifyGate', () => {
  it('treats OOM kills, daemon errors, disk full and timeouts as infra', () => {
    expect(classifyGate({ exitCode: 137, timedOut: false, stderrTail: '' })).toBe('infra');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' })).toBe('infra');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: 'write /work/x: no space left on device' })).toBe('infra');
    expect(classifyGate({ exitCode: null, timedOut: true, stderrTail: '' })).toBe('infra');
  });

  it('treats an ordinary non-zero exit as code', () => {
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: '3 tests failed' })).toBe('code');
  });
});

describe('runGate', () => {
  it('passes on exit 0 and picks up the JUnit report', async () => {
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ stdout: 'ok' }));
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, readFile: files({ '/home/u/ws/worktrees/T1-create/reports/junit.xml': JUNIT }) });
    expect(r).toMatchObject({ name: 'unit-test', passed: true, exitCode: 0, failure: null });
    expect(r.junit).toHaveLength(2);
    expect(r.junit![1]!.status).toBe('failed');
  });

  it('reports a code failure with output tails when the command exits non-zero', async () => {
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 1, stdout: 'x'.repeat(10_000), stderr: 'FAIL src/a.test.ts' }));
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, readFile: files({}) });
    expect(r.passed).toBe(false);
    expect(r.failure).toBe('code');
    expect(r.stdoutTail.length).toBe(4000);
    expect(r.junit).toBeNull();
  });

  it('reports infra when the container is OOM-killed', async () => {
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 137 }));
    const r = await runGate(gate({ name: 'build', command: 'npm run build' }), ctx, { exec: fake.exec, readFile: files({}) });
    expect(r.failure).toBe('infra');
  });

  it('reports infra when docker itself cannot be spawned', async () => {
    const r = await runGate(gate({ name: 'build', command: 'npm run build' }), ctx, {
      exec: async () => {
        throw new Error('cannot run docker: spawn docker ENOENT');
      },
      readFile: files({}),
    });
    expect(r).toMatchObject({ passed: false, failure: 'infra' });
    expect(r.stderrTail).toMatch(/ENOENT/);
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
    const fake = new FakeExec().on((s) => s.args.includes('npm test'), () => ({ exitCode: 1, stderr: 'boom' }));
    const out = await runGates(gates, ctx, { exec: fake.exec, readFile: files({}) });
    expect(out.results.map((r) => r.name)).toEqual(['lint', 'unit-test']);
    expect(out.blockingFailure?.name).toBe('unit-test');
  });

  it('runs every gate when only a non-blocking one fails', async () => {
    const fake = new FakeExec().on((s) => s.args.includes('osv-scanner .'), () => ({ exitCode: 2, stdout: 'vuln' }));
    const out = await runGates(gates, ctx, { exec: fake.exec, readFile: files({}) });
    expect(out.results.map((r) => r.passed)).toEqual([true, true, false, true]);
    expect(out.blockingFailure).toBeNull();
  });
});
