import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DockerLocalTarget } from '../../server/deploy/docker-local.js';
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
  it('builds, parks the old container, runs the new one bound to localhost with secrets in the environment, verifies', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ stdout: 'todo-api:spec-001-old0000\n' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    expect(await t.validate(intent)).toEqual([]);
    await t.build(intent);
    const { previous } = await t.apply(intent);
    expect(previous).toBe('todo-api:spec-001-old0000');
    const lines = fake.lines('docker');
    expect(lines[0]).toBe('build -t todo-api:spec-001-abc1234 /home/u/ws/repo');
    expect(lines).toContain('rename teams-ai-todo-api teams-ai-todo-api-prev');
    expect(lines.indexOf('stop teams-ai-todo-api-prev')).toBeGreaterThan(lines.indexOf('rename teams-ai-todo-api teams-ai-todo-api-prev')); // the parked container must free the port
    const run = fake.calls.find((c) => c.args[0] === 'run')!;
    expect(run.args).toEqual(expect.arrayContaining(['-d', '--name', 'teams-ai-todo-api', '-p', '127.0.0.1:3000:3000', '-e', 'DATABASE_URL', 'todo-api:spec-001-abc1234']));
    expect(run.args.join(' ')).not.toContain('postgres://x');
    expect(run.env).toEqual({ DATABASE_URL: 'postgres://x' });
    expect(lines).toContain('rm -f teams-ai-todo-api-prev');
    expect(await t.verify(intent)).toMatchObject({ healthy: true });
    expect(await t.currentImage(intent)).toBe('todo-api:spec-001-old0000');
  });

  it('restores the parked container when docker run fails, then rethrows', async () => {
    const fake = new FakeExec()
      .onArgs('docker', ['inspect'], () => ({ stdout: 'todo-api:old\n' }))
      .onArgs('docker', ['run'], () => ({ exitCode: 125, stderr: 'port is already allocated' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    await expect(t.apply(intent)).rejects.toThrow(/port is already allocated/);
    const lines = fake.lines('docker');
    const runAt = fake.calls.findIndex((c) => c.args[0] === 'run');
    const after = fake.calls.slice(runAt + 1).map((c) => c.args.join(' '));
    expect(after).toEqual(expect.arrayContaining(['rename teams-ai-todo-api-prev teams-ai-todo-api', 'start teams-ai-todo-api']));
    expect(after).not.toContain('rm -f teams-ai-todo-api-prev');
    expect(lines).toContain('rename teams-ai-todo-api teams-ai-todo-api-prev');
  });

  it('reports the running image as previous even when it is the one being deployed, so a failure restarts it instead of tearing it down', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect', '--format', '{{.Config.Image}}'], () => ({ stdout: 'todo-api:spec-001-abc1234\n' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    expect((await t.apply(intent)).previous).toBe('todo-api:spec-001-abc1234');
  });

  it('reports no previous image when nothing was running', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ exitCode: 1, stderr: 'No such object' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    expect((await t.apply(intent)).previous).toBeNull();
    expect(fake.lines('docker')).not.toContain('rename teams-ai-todo-api teams-ai-todo-api-prev');
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

describe('runDeployment', () => {
  function target(over: Partial<DeployTarget> = {}, log: string[] = []): DeployTarget {
    return {
      name: 'docker-local',
      validate: async () => (log.push('validate'), []),
      build: async () => void log.push('build'),
      apply: async () => (log.push('apply'), { previous: 'img:old' }),
      verify: async () => (log.push('verify'), { healthy: true, detail: 'ok' }),
      currentImage: async () => (log.push('image'), 'img:old'),
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

  it('rolls back when the smoke suite fails and confirms the old image is healthy and running', async () => {
    const log: string[] = [];
    const r = await runDeployment(target({}, log), intent, { smoke: async () => ({ ok: false, detail: '[AC-001] failed' }), baseUrl: 'u' });
    expect(r).toEqual({ ok: false, stage: 'smoke', detail: '[AC-001] failed', rolledBack: true, rollbackHealthy: true });
    expect(log).toEqual(['validate', 'build', 'apply', 'verify', 'rollback', 'verify', 'image']);
  });

  it('reports rollbackHealthy=false when a different image is running after the rollback', async () => {
    const r = await runDeployment(target({ currentImage: async () => 'img:other' }), intent, { smoke: async () => ({ ok: false, detail: 'x' }), baseUrl: 'u' });
    expect(r).toMatchObject({ ok: false, stage: 'smoke', rolledBack: true, rollbackHealthy: false });
    if (!r.ok) expect(r.detail).toContain('img:other');
  });

  it('reports an unhealthy deploy with no rollback when there was no previous version', async () => {
    const r = await runDeployment(
      target({ apply: async () => ({ previous: null }), verify: async () => ({ healthy: false, detail: 'timeout' }) }),
      intent,
      { smoke: smokeOk, baseUrl: 'u' },
    );
    expect(r).toMatchObject({ ok: false, stage: 'verify', rolledBack: false, rollbackHealthy: null });
    if (!r.ok) expect(r.detail).toBe('timeout; first deploy failed, the new stack was torn down');
  });

  it('tears the new stack down with destroy when the first deploy fails, never rolling back', async () => {
    const log: string[] = [];
    const r = await runDeployment(target({ apply: async () => ({ previous: null }) }, log), intent, { smoke: async () => ({ ok: false, detail: 'x' }), baseUrl: 'u' });
    expect(r).toMatchObject({ ok: false, stage: 'smoke', rolledBack: false });
    expect(log).toEqual(['validate', 'build', 'verify', 'destroy']);
  });

  it('reports a failing teardown of a first deploy instead of rejecting', async () => {
    const r = await runDeployment(
      target({ apply: async () => ({ previous: null }), verify: async () => ({ healthy: false, detail: 'down' }), destroy: async () => { throw new Error('compose down failed'); } }),
      intent,
      { smoke: smokeOk, baseUrl: 'u' },
    );
    expect(r).toMatchObject({ ok: false, stage: 'verify', rolledBack: false });
    if (!r.ok) expect(r.detail).toBe('down; teardown of the failed first deploy failed: compose down failed');
  });

  it('docker-local compose: a failed first deploy runs compose down for the project', async () => {
    const fake = new FakeExec().onArgs('docker', ['compose'], (s) => (s.args.includes('ps') ? { stdout: '' } : {}));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    const ci = { ...intent, compose: 'docker-compose.yml' };
    const r = await runDeployment(Object.assign(Object.create(t), { apply: async () => ({ previous: null }) }) as DeployTarget, ci, { smoke: smokeOk, baseUrl: 'u' });
    expect(r).toMatchObject({ ok: false, stage: 'verify', rolledBack: false });
    expect(fake.lines('docker').some((l) => l.startsWith('compose -p ') && l.includes(' down'))).toBe(true);
  });

  it('turns a throwing rollback into a result instead of a rejection', async () => {
    const r = await runDeployment(
      target({ verify: async () => ({ healthy: false, detail: 'down' }), rollback: async () => { throw new Error('docker run failed'); } }),
      intent,
      { smoke: smokeOk, baseUrl: 'u' },
    );
    expect(r).toEqual({ ok: false, stage: 'verify', detail: 'down; rollback failed: docker run failed', rolledBack: false, rollbackHealthy: false });
  });
});

describe('imageRef', () => {
  it('replaces a tag the plan already put on the image and keeps a registry port', async () => {
    const { imageName, imageRef } = await import('../../server/deploy/target.js');
    expect(imageName('client-management:latest')).toBe('client-management');
    expect(imageName('ghcr.io/acme/app:1.2')).toBe('ghcr.io/acme/app');
    expect(imageName('localhost:5000/app')).toBe('localhost:5000/app');
    expect(imageRef({ image: 'client-management:latest', tag: '44e0b56' } as never)).toBe('client-management:44e0b56');
  });
});

describe('DockerLocalTarget: containerized orchestrator', () => {
  it('reaches the service through serviceHost and publishes on publishBind', async () => {
    const { DockerLocalTarget } = await import('../../server/deploy/docker-local.js');
    const t = new DockerLocalTarget({ exec: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false }), get: async () => ({ status: 200, body: '' }), secrets: {}, serviceHost: 'host.docker.internal', publishBind: '0.0.0.0' });
    expect(t.baseUrl({ port: 3000 } as never)).toBe('http://host.docker.internal:3000');
  });
});
