import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DockerLocalTarget } from '../../server/deploy/docker-local.js';
import { KindTarget } from '../../server/deploy/kind.js';
import { archivePath, type DeploymentIntent } from '../../server/deploy/target.js';
import { deployIntent } from '../../server/orchestrator/phases/deploy.js';
import { writeToolsInstaller } from '../../server/orchestrator/tools-install.js';
import { renderToolsInstaller } from '../../server/validators/tools-installer.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const intent: DeploymentIntent = {
  projectId: 'todo-api',
  image: 'todo-api',
  tag: 'spec-001-abc1234',
  port: 3000,
  healthcheckPath: '/health',
  manifests: ['deploy/k8s.yaml'],
  secretNames: [],
  contextDir: '/home/u/ws/repo',
  imageArchive: '.tools/image.tar',
};
const ARCHIVE = '/home/u/ws/repo/.tools/image.tar';
const registry = { buildkitAddr: 'tcp://buildkitd:1234', pushHost: 'registry:5000', pullHost: 'registry.teams-ai:5000', namespace: 'teams-ai' };

describe('image archive export', () => {
  it('archivePath is null without a request and absolute with one', () => {
    expect(archivePath({ ...intent, imageArchive: undefined })).toBeNull();
    expect(archivePath(intent)).toBe(ARCHIVE);
  });

  it('kind registry build adds an OCI output at the archive path', async () => {
    const fake = new FakeExec();
    await new KindTarget({ exec: fake.exec, secrets: {}, cluster: 'teams-ai', readFile: async () => '', sleep: async () => undefined, registry }).build(intent);
    expect(fake.lines('mkdir')).toEqual(['-p /home/u/ws/repo/.tools']);
    expect(fake.lines('buildctl')[0]).toContain(`--output type=image,name=registry:5000/todo-api:spec-001-abc1234,push=true,registry.insecure=true --output type=oci,dest=${ARCHIVE}`);
  });

  it('kind without registry saves the built image', async () => {
    const fake = new FakeExec();
    await new KindTarget({ exec: fake.exec, secrets: {}, cluster: 'teams-ai', readFile: async () => '', sleep: async () => undefined }).build(intent);
    expect(fake.lines('docker')).toContain(`save -o ${ARCHIVE} todo-api:spec-001-abc1234`);
  });

  it('docker-local saves the built image', async () => {
    const fake = new FakeExec();
    await new DockerLocalTarget({ exec: fake.exec, get: async () => ({ status: 200 }), secrets: {} }).build(intent);
    expect(fake.lines('docker')).toEqual([`build -t todo-api:spec-001-abc1234 /home/u/ws/repo`, `save -o ${ARCHIVE} todo-api:spec-001-abc1234`]);
  });

  it('a failed save fails the build; no request means no export', async () => {
    const bad = new FakeExec().onArgs('docker', ['save'], () => ({ exitCode: 1, stderr: 'disk full' }));
    await expect(new DockerLocalTarget({ exec: bad.exec, get: async () => ({ status: 200 }), secrets: {} }).build(intent)).rejects.toThrow('docker save failed: disk full');
    const fake = new FakeExec();
    await new DockerLocalTarget({ exec: fake.exec, get: async () => ({ status: 200 }), secrets: {} }).build({ ...intent, imageArchive: undefined });
    expect(fake.lines('docker')).toEqual(['build -t todo-api:spec-001-abc1234 /home/u/ws/repo']);
  });

  it('the deploy intent requests the archive only for plans with an image-scan gate', () => {
    const mk = (names: string[]) =>
      ({ project: { projectId: 'p' }, ws: { repo: '/r' }, spec: { externalDependencies: [] }, plan: { deploy: { image: 'i', port: 1, healthcheckPath: '/', manifests: [] }, gates: names.map((name) => ({ name })) } }) as never;
    expect(deployIntent(mk(['image-scan']), 't').imageArchive).toBe('.tools/image.tar');
    expect(deployIntent(mk(['build']), 't').imageArchive).toBeUndefined();
  });
});

describe('writeToolsInstaller', () => {
  it('writes the rendered script into .tools/install.sh of the worktree', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tools-'));
    try {
      const file = await writeToolsInstaller(dir);
      expect(file).toBe(path.join(dir, '.tools', 'install.sh'));
      expect(readFileSync(file, 'utf8')).toBe(renderToolsInstaller());
      expect(statSync(file).isFile()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
