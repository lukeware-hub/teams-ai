import { describe, expect, it } from 'vitest';
import { DockerLocalTarget } from '../../server/deploy/docker-local.js';
import { KindTarget } from '../../server/deploy/kind.js';
import { runDeployment, waitHealthy, type DeploymentIntent, type DeployTarget, type HttpGet } from '../../server/deploy/target.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const intent: DeploymentIntent = {
  projectId: 'todo-api',
  image: 'todo-api',
  tag: 'spec-001-abc1234',
  port: 3000,
  healthcheckPath: '/health',
  manifests: ['deploy/k8s.yaml'],
  secretNames: ['DATABASE_URL'],
  contextDir: '/home/u/ws/repo',
};
const secrets = { DATABASE_URL: 'postgres://x' };
const okGet: HttpGet = async () => ({ status: 200 });
const downGet: HttpGet = async () => null;

describe('waitHealthy', () => {
  it('polls until a 2xx arrives within the deadline', async () => {
    let calls = 0;
    const get: HttpGet = async () => (++calls < 3 ? null : { status: 200 });
    const r = await waitHealthy('http://x/health', get, { timeoutMs: 1_000, intervalMs: 1 });
    expect(r).toEqual({ healthy: true, detail: 'HTTP 200 after 3 attempts' });
  });

  it('gives up at the deadline', async () => {
    const r = await waitHealthy('http://x/health', downGet, { timeoutMs: 20, intervalMs: 5 });
    expect(r.healthy).toBe(false);
  });
});

describe('DockerLocalTarget', () => {
  it('builds, replaces the container, remembers the previous image and verifies', async () => {
    const fake = new FakeExec()
      .onArgs('docker', ['inspect'], () => ({ stdout: 'todo-api:spec-001-old0000\n' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    expect(await t.validate(intent)).toEqual([]);
    await t.build(intent);
    const { previous } = await t.apply(intent);
    expect(previous).toBe('todo-api:spec-001-old0000');
    const lines = fake.lines('docker');
    expect(lines[0]).toBe('build -t todo-api:spec-001-abc1234 /home/u/ws/repo');
    expect(lines).toContain('rm -f teams-ai-todo-api');
    const run = fake.calls.find((c) => c.args[0] === 'run')!;
    expect(run.args).toEqual(expect.arrayContaining(['-d', '--name', 'teams-ai-todo-api', '-p', '3000:3000', '-e', 'DATABASE_URL=postgres://x', 'todo-api:spec-001-abc1234']));
    expect(await t.verify(intent)).toMatchObject({ healthy: true });
  });

  it('reports no previous image when nothing was running', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ exitCode: 1, stderr: 'No such object' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    expect((await t.apply(intent)).previous).toBeNull();
  });

  it('rolls back by running the previous image and validates missing secrets', async () => {
    const fake = new FakeExec();
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets: {} });
    expect(await t.validate(intent)).toEqual(['missing secret DATABASE_URL']);
    await new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets }).rollback(intent, 'todo-api:spec-001-old0000');
    const run = fake.calls.filter((c) => c.args[0] === 'run').pop()!;
    expect(run.args.at(-1)).toBe('todo-api:spec-001-old0000');
  });
});

describe('KindTarget', () => {
  const manifest = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: todo-api\nspec:\n  template:\n    spec:\n      containers:\n      - name: app\n        image: {{IMAGE}}\n';

  it('loads the image, renders and applies manifests, remembers the previous image', async () => {
    const fake = new FakeExec().onArgs('kubectl', ['get', 'deploy'], () => ({ stdout: 'todo-api:spec-001-old0000' }));
    const t = new KindTarget({ exec: fake.exec, secrets, cluster: 'teams-ai', readFile: async () => manifest });
    await t.build(intent);
    const { previous } = await t.apply(intent);
    expect(previous).toBe('todo-api:spec-001-old0000');
    expect(fake.lines('kind')).toEqual(['load docker-image todo-api:spec-001-abc1234 --name teams-ai']);
    // The first 'apply -f -' is the Secret (from the dry-run output); the manifests come last.
    const apply = fake.calls.filter((c) => c.bin === 'kubectl' && c.args[0] === 'apply').pop()!;
    expect(apply.args).toEqual(['apply', '-f', '-']);
    expect(apply.stdin).toContain('image: todo-api:spec-001-abc1234');
    expect(apply.stdin).not.toContain('{{IMAGE}}');
    const secret = fake.calls.find((c) => c.bin === 'kubectl' && c.args[0] === 'create')!;
    expect(secret.args.join(' ')).toContain('secret generic todo-api-secrets');
    expect(secret.args.join(' ')).not.toContain('postgres://x');
    expect(secret.stdin).toContain('postgres://x');
  });

  it('verifies with rollout status and an in-cluster probe, and rolls back with rollout undo', async () => {
    const fake = new FakeExec().onArgs('kubectl', ['run'], () => ({ stdout: '200' }));
    const t = new KindTarget({ exec: fake.exec, secrets, cluster: 'teams-ai', readFile: async () => manifest });
    expect(await t.verify(intent)).toMatchObject({ healthy: true });
    expect(fake.lines('kubectl')[0]).toBe('rollout status deployment/todo-api --timeout=120s');
    await t.rollback(intent, 'todo-api:spec-001-old0000');
    expect(fake.lines('kubectl')).toContain('rollout undo deployment/todo-api');
  });
});

describe('runDeployment', () => {
  function target(over: Partial<DeployTarget> = {}, log: string[] = []): DeployTarget {
    return {
      name: 'docker-local',
      validate: async () => (log.push('validate'), []),
      build: async () => void log.push('build'),
      apply: async () => (log.push('apply'), { previous: 'img:old' }),
      verify: async () => (log.push('verify'), { healthy: true, detail: 'ok' }),
      rollback: async () => void log.push('rollback'),
      destroy: async () => void log.push('destroy'),
      ...over,
    };
  }
  const smokeOk = async () => ({ ok: true, detail: 'ok' });

  it('runs validate → build → apply → verify → smoke', async () => {
    const log: string[] = [];
    const r = await runDeployment(target({}, log), intent, { smoke: smokeOk, baseUrl: 'http://127.0.0.1:3000' });
    expect(r).toEqual({ ok: true, previous: 'img:old' });
    expect(log).toEqual(['validate', 'build', 'apply', 'verify']);
  });

  it('stops on validation errors without building', async () => {
    const log: string[] = [];
    const r = await runDeployment(target({ validate: async () => ['missing secret X'] }, log), intent, { smoke: smokeOk, baseUrl: 'u' });
    expect(r).toMatchObject({ ok: false, stage: 'validate', detail: 'missing secret X', rolledBack: false });
    expect(log).toEqual([]);
  });

  it('rolls back when the smoke suite fails after a healthy deploy and confirms the old version is healthy', async () => {
    const log: string[] = [];
    let verifies = 0;
    const r = await runDeployment(
      target({ verify: async () => (log.push('verify'), { healthy: true, detail: `v${++verifies}` }) }, log),
      intent,
      { smoke: async () => ({ ok: false, detail: '[AC-001] failed' }), baseUrl: 'u' },
    );
    expect(r).toEqual({ ok: false, stage: 'smoke', detail: '[AC-001] failed', rolledBack: true, rollbackHealthy: true });
    expect(log).toEqual(['validate', 'build', 'apply', 'verify', 'rollback', 'verify']);
  });

  it('reports an unhealthy deploy with no rollback when there was no previous version', async () => {
    const r = await runDeployment(
      target({ apply: async () => ({ previous: null }), verify: async () => ({ healthy: false, detail: 'timeout' }) }),
      intent,
      { smoke: smokeOk, baseUrl: 'u' },
    );
    expect(r).toEqual({ ok: false, stage: 'verify', detail: 'timeout', rolledBack: false, rollbackHealthy: null });
  });
});
