import { describe, expect, it } from 'vitest';
import { Gate as GateSchema, type Gate } from '../../server/contracts/plan.js';
import { buildGateManifests, GATE_WRAPPER, jobName, K8sGateExecutor, splitGateLogs, STDERR_MARK, STDOUT_MARK, type K8sExecutorConfig } from '../../server/exec/k8s-gate-executor.js';
import { runGate, type GateContext } from '../../server/exec/gate-runner.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const cfg: K8sExecutorConfig = { namespace: 'teams-ai', serviceAccount: 'default', workspacePvc: 'teams-ai-data', workspaceRoot: '/root/.teams-ai', workspaceSubPath: 'teams-ai', runAsUser: 1000, runAsGroup: 1000 };
const ctx: GateContext = {
  worktree: '/root/.teams-ai/ws/worktrees/T1',
  image: 'node:22-bookworm',
  junitPath: 'reports/junit.xml',
  cpus: 2,
  memory: '2g',
  timeoutMs: 600_000,
  secrets: { NPM_TOKEN: 'npm_SECRET', OTHER: 'unused' },
  containerName: 'teams-ai-r1-T1',
};
const gate = (over: Partial<Gate> & { name: string; command: string }): Gate => GateSchema.parse({ blocking: true, ...over });
const labels = (network: string) => ({ 'app.kubernetes.io/managed-by': 'teams-ai', 'teams-ai.dev/gate': 'unit-test', 'teams-ai.dev/network': network });
const NAME = 'teams-ai-r1-t1-unit-test';

describe('buildGateManifests', () => {
  it('builds the golden Job and Secret for an offline gate', () => {
    const m = buildGateManifests(gate({ name: 'unit-test', command: 'npm test', secrets: ['NPM_TOKEN'] }), ctx, cfg);
    expect(m.name).toBe(NAME);
    expect(m.secret).toEqual({ apiVersion: 'v1', kind: 'Secret', metadata: { name: NAME, namespace: 'teams-ai', labels: labels('deny') }, type: 'Opaque', stringData: { NPM_TOKEN: 'npm_SECRET' } });
    expect(m.job).toEqual({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: NAME, namespace: 'teams-ai', labels: labels('deny') },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 600,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: { labels: labels('deny') },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: 'default',
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
            containers: [
              {
                name: 'gate',
                image: 'node:22-bookworm',
                command: ['sh', '-c', GATE_WRAPPER, 'gate', 'npm test'],
                workingDir: '/work',
                env: [{ name: 'HOME', value: '/tmp' }, { name: 'NPM_TOKEN', valueFrom: { secretKeyRef: { name: NAME, key: 'NPM_TOKEN' } } }],
                resources: { limits: { cpu: '2', memory: '2Gi' } },
                securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
                volumeMounts: [
                  { name: 'workspace', mountPath: '/work', subPath: 'teams-ai/ws/worktrees/T1' },
                  { name: 'workspace', mountPath: '/work/.git', subPath: 'teams-ai/ws/worktrees/T1/.git', readOnly: true },
                ],
              },
            ],
            volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'teams-ai-data' } }],
          },
        },
      },
    });
  });

  it('labels egress gates, omits the Secret without declared secrets, and rejects a missing secret or foreign path', () => {
    const m = buildGateManifests(gate({ name: 'unit-test', command: 'x', network: 'egress' }), ctx, cfg);
    expect(m.secret).toBeNull();
    expect((m.job.metadata as { labels: Record<string, string> }).labels['teams-ai.dev/network']).toBe('egress');
    expect(() => buildGateManifests(gate({ name: 'g', command: 'x', secrets: ['MISSING'] }), ctx, cfg)).toThrow(/MISSING/);
    expect(() => buildGateManifests(gate({ name: 'g', command: 'x' }), { ...ctx, worktree: '/elsewhere/wt' }, cfg)).toThrow(/not under the workspace/);
  });

  it('keeps job names valid and unique when long', () => {
    const long = jobName(`teams-ai-run-${'x'.repeat(80)}__feat`, 'Unit_Test');
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(jobName(`${'a'.repeat(70)}1`, 'g')).not.toBe(jobName(`${'a'.repeat(70)}2`, 'g'));
  });
});

const jobJson = (...conds: Array<{ type: string; reason?: string }>) => JSON.stringify({ status: { conditions: conds.map((c) => ({ status: 'True', ...c })) } });
const podJson = (cs: unknown) => JSON.stringify({ items: [{ status: { containerStatuses: [cs] } }] });

function setup(job: () => Partial<{ exitCode: number; stdout: string; stderr: string }>, pods: () => string = () => '{}') {
  const fake = new FakeExec()
    .onArgs('kubectl', ['-n', 'teams-ai', 'get', `job/${NAME}`], job)
    .onArgs('kubectl', ['-n', 'teams-ai', 'get', 'pods'], () => ({ stdout: pods() }))
    .onArgs('kubectl', ['-n', 'teams-ai', 'logs'], () => ({ stdout: 'log line' }));
  let t = 0;
  const executor = new K8sGateExecutor({ exec: fake.exec, config: cfg, sleep: async (ms) => void (t += ms), now: () => t });
  return { fake, executor };
}
const verbs = (fake: FakeExec) => fake.lines('kubectl').map((l) => l.split(' ').slice(2, 4).join(' '));
const g = gate({ name: 'unit-test', command: 'npm test', secrets: ['NPM_TOKEN'] });

describe('K8sGateExecutor lifecycle', () => {
  it('applies the Secret and Job on stdin, waits, reads logs and always cleans up', async () => {
    const { fake, executor } = setup(() => ({ stdout: jobJson({ type: 'Complete' }) }));
    const r = await executor.run(g, ctx);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'log line' });
    const apply = fake.calls.find((c) => c.args.includes('apply'))!;
    const list = JSON.parse(apply.stdin!) as { items: Array<{ kind: string }> };
    expect(list.items.map((i) => i.kind)).toEqual(['Secret', 'Job']);
    // Secret values travel on stdin only.
    expect(fake.calls.some((c) => c.args.join(' ').includes('npm_SECRET'))).toBe(false);
    expect(verbs(fake)).toEqual(['delete job/' + NAME, 'apply -f', 'get job/' + NAME, 'logs job/' + NAME, 'delete job/' + NAME]);
    expect(fake.lines('kubectl').at(-1)).toContain(`secret/${NAME} --ignore-not-found --wait=false`);
  });

  it('polls until the Job finishes', async () => {
    let n = 0;
    const { fake, executor } = setup(() => ({ stdout: ++n < 3 ? '{}' : jobJson({ type: 'Complete' }) }));
    expect((await executor.run(g, ctx)).exitCode).toBe(0);
    expect(fake.lines('kubectl').filter((l) => l.includes(' get job/')).length).toBe(3);
  });

  it('returns the container exit code for a failed Job and flags OOMKilled', async () => {
    const failed = setup(() => ({ stdout: jobJson({ type: 'Failed', reason: 'BackoffLimitExceeded' }) }), () => podJson({ state: { terminated: { exitCode: 2, reason: 'Error' } } }));
    expect(await failed.executor.run(g, ctx)).toMatchObject({ exitCode: 2, timedOut: false, stderr: '' });
    const oom = setup(() => ({ stdout: jobJson({ type: 'Failed' }) }), () => podJson({ state: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }));
    expect(await oom.executor.run(g, ctx)).toMatchObject({ exitCode: 137, stderr: 'OOMKilled' });
  });

  it('reports a deadline-exceeded Job as a timeout', async () => {
    const { fake, executor } = setup(() => ({ stdout: jobJson({ type: 'Failed', reason: 'DeadlineExceeded' }) }));
    expect(await executor.run(g, ctx)).toMatchObject({ exitCode: null, timedOut: true });
    expect(verbs(fake).at(-1)).toBe('delete job/' + NAME);
  });

  it('gives up on its own after the deadline plus grace when the Job never finishes', async () => {
    const { fake, executor } = setup(() => ({ stdout: '{}' }));
    const r = await executor.run(g, { ...ctx, timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
    expect(verbs(fake).at(-1)).toBe('delete job/' + NAME);
  });

  it('aborts early when the pod cannot pull its image, still cleaning up', async () => {
    const { fake, executor } = setup(() => ({ stdout: '{}' }), () => podJson({ state: { waiting: { reason: 'ImagePullBackOff', message: 'pull access denied' } } }));
    await expect(executor.run(g, ctx)).rejects.toThrow(/ImagePullBackOff/);
    expect(verbs(fake).at(-1)).toBe('delete job/' + NAME);
  });

  it('rejects when kubectl apply fails and still cleans up', async () => {
    const fake = new FakeExec().onArgs('kubectl', ['-n', 'teams-ai', 'apply'], () => ({ exitCode: 1, stderr: 'forbidden' }));
    const executor = new K8sGateExecutor({ exec: fake.exec, config: cfg, sleep: async () => undefined });
    await expect(executor.run(g, ctx)).rejects.toThrow(/apply failed: forbidden/);
    expect(fake.lines('kubectl').filter((l) => l.includes(' delete '))).toHaveLength(2);
    expect(fake.lines('kubectl').some((l) => l.includes(' get '))).toBe(false);
  });

  it('plugs into runGate: JUnit comes from the worktree, an apply failure is an infra failure', async () => {
    const { executor } = setup(() => ({ stdout: jobJson({ type: 'Complete' }) }));
    const xml = '<testsuite name="s"><testcase classname="c" name="[AC-001] ok"/></testsuite>';
    const files = new Map([['/root/.teams-ai/ws/worktrees/T1/reports/junit.xml', xml]]);
    const deps = { exec: new FakeExec().exec, executor, readFile: async (p: string) => files.get(p) ?? null, removeFile: async () => undefined };
    const ok = await runGate(g, ctx, deps);
    expect(ok).toMatchObject({ passed: true, failure: null });
    expect(ok.junit).toHaveLength(1);

    const bad = new FakeExec().onArgs('kubectl', ['-n', 'teams-ai', 'apply'], () => ({ exitCode: 1, stderr: 'token npm_SECRET rejected' }));
    const r = await runGate(g, ctx, { ...deps, executor: new K8sGateExecutor({ exec: bad.exec, config: cfg, sleep: async () => undefined }) });
    expect(r).toMatchObject({ passed: false, failure: 'infra' });
    expect(r.stderrTail).not.toContain('npm_SECRET');
  });
});

describe('separate stdout and stderr', () => {
  const wrapped = (out: string, err: string) => `noise\n${STDOUT_MARK}\n${out}\n${STDERR_MARK}\n${err}`;
  const run = (log: string, exitCode: number) => {
    const fake = new FakeExec()
      .onArgs('kubectl', ['-n', 'teams-ai', 'get', `job/${NAME}`], () => ({ stdout: jobJson(exitCode === 0 ? { type: 'Complete' } : { type: 'Failed' }) }))
      .onArgs('kubectl', ['-n', 'teams-ai', 'get', 'pods'], () => ({ stdout: podJson({ state: { terminated: { exitCode, reason: 'Error' } } }) }))
      .onArgs('kubectl', ['-n', 'teams-ai', 'logs'], () => ({ stdout: log }));
    const executor = new K8sGateExecutor({ exec: fake.exec, config: cfg, sleep: async () => undefined });
    return runGate(g, ctx, { exec: new FakeExec().exec, executor, readFile: async () => null, removeFile: async () => undefined });
  };

  it('runs the command with its own redirection, passed as an argument and not interpolated', () => {
    expect(GATE_WRAPPER).toContain('>/tmp/gate.out 2>/tmp/gate.err');
    expect(GATE_WRAPPER).toContain('"$1"');
    expect(GATE_WRAPPER).toContain('exit $rc');
  });

  it('splits the two sections and falls back to all-stdout without markers', () => {
    expect(splitGateLogs(wrapped('out line', 'err line'))).toEqual({ stdout: 'out line', stderr: 'err line' });
    expect(splitGateLogs('killed mid-way')).toEqual({ stdout: 'killed mid-way', stderr: '' });
  });

  it('classifies an infra-looking stderr as infra', async () => {
    const r = await run(wrapped('', 'write error: no space left on device'), 1);
    expect(r).toMatchObject({ passed: false, failure: 'infra' });
    expect(r.stderrTail).toContain('no space left on device');
  });

  it('classifies a test failure on stdout as code', async () => {
    const r = await run(wrapped('FAIL src/a.test.ts\nExpected 1 to be 2', ''), 1);
    expect(r).toMatchObject({ passed: false, failure: 'code' });
    expect(r.stdoutTail).toContain('Expected 1 to be 2');
  });
});
