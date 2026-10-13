import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_PORTS } from '../../server/deploy/service-links.js';
import { deployIntent, runPhase5 } from '../../server/orchestrator/phases/deploy.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { FakeExec } from '../fixtures/fake-exec.js';

type Fact = { type: string; data: Record<string, unknown> };

function setup(ps: string, apply: (intent: { port: number }) => Promise<{ previous: string | null }>) {
  const events: Fact[] = [];
  const journal = {
    events,
    state: { tasks: new Map() },
    fact: async (type: string, data: Record<string, unknown>) => void events.push({ type, data }),
    intent: async () => undefined,
    confirm: async () => undefined,
    isConfirmed: () => false,
  };
  const fake = new FakeExec().onArgs('docker', ['ps'], () => ({ stdout: ps }));
  const target = { validate: async () => [], build: async () => undefined, currentImage: async () => null, apply, verify: async () => ({ healthy: true, detail: 'ok' }), destroy: async () => undefined, serviceUrl: () => 'http://x' };
  const deps = {
    journal,
    exec: fake.exec,
    workspacesRoot: mkdtempSync(path.join(os.tmpdir(), 'teams-ai-deploy-port-')),
    ws: { repo: '/r' },
    project: { projectId: 'rust' },
    spec: { externalDependencies: [] },
    plan: { deploy: { image: 'i', port: 3001, healthcheckPath: '/', manifests: ['docker-compose.yml'] }, gates: [], delivery: { compose: 'docker-compose.yml' } },
    target,
    smoke: async () => ({ ok: true, rows: [], detail: '' }),
  };
  return { deps: deps as never, events };
}

const fixTaskOf = (r: Awaited<ReturnType<typeof runPhase5>>) => (r.ok ? null : r.fixTask ?? null);
const inRange = (p: unknown) => typeof p === 'number' && p >= PUBLISHED_PORTS.from && p <= PUBLISHED_PORTS.to;

describe('deploy port conflict', () => {
  it('moves the port before applying when another project holds it', async () => {
    let applied = false;
    const { deps, events } = setup('other|127.0.0.1:3001->3001/tcp\n', async () => ((applied = true), { previous: null }));
    const task = fixTaskOf(await runPhase5(deps, 1));
    const moved = events.find((e) => e.type === OrchEvent.DeployPortReassigned)!;
    expect(applied).toBe(false);
    expect(moved.data.from).toBe(3001);
    expect(inRange(moved.data.to)).toBe(true);
    expect(task?.owner).toBe('devops');
    expect(task?.description).toContain(`port ${moved.data.to}`);
    expect(deployIntent(deps, 't').port).toBe(moved.data.to);
  });

  it('moves the port when the bind fails at apply', async () => {
    const { deps, events } = setup('', async () => {
      throw new Error('docker compose up failed: Bind for 0.0.0.0:3001 failed: port is already allocated');
    });
    const task = fixTaskOf(await runPhase5(deps, 1));
    const moved = events.find((e) => e.type === OrchEvent.DeployPortReassigned)!;
    expect(inRange(moved.data.to)).toBe(true);
    expect(task?.description).toContain(`"${moved.data.to}:${moved.data.to}"`);
  });

  it('keeps the port when the failure is not a port conflict', async () => {
    const { deps, events } = setup('', async () => {
      throw new Error('docker compose up failed: image not found');
    });
    const task = fixTaskOf(await runPhase5(deps, 1));
    expect(events.some((e) => e.type === OrchEvent.DeployPortReassigned)).toBe(false);
    expect(task?.description).not.toContain('host port is taken');
  });

  it('a deploy with no agent moves to a free port and deploys there when another project holds the port', async () => {
    let appliedOn = 0;
    const { deps, events } = setup('other|127.0.0.1:3001->3001/tcp\n', async (intent) => ((appliedOn = intent.port), { previous: null }));
    const result = await runPhase5(deps, 1, { fixTasks: false });
    const moved = events.find((e) => e.type === OrchEvent.DeployPortReassigned)!;
    expect(result.ok).toBe(true);
    expect(inRange(moved.data.to)).toBe(true);
    expect(appliedOn).toBe(moved.data.to);
    expect(events.find((e) => e.type === OrchEvent.DeployVerified)!.data.port).toBe(moved.data.to);
  });
});
