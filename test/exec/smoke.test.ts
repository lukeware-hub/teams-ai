import { describe, expect, it } from 'vitest';
import { gateReachableUrl, runSmoke, serviceUrlEnv } from '../../server/exec/smoke.js';
import type { GateContext } from '../../server/exec/gate-runner.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

describe('serviceUrlEnv', () => {
  it('names the variable that carries another service address', () => {
    expect(serviceUrlEnv('orders')).toBe('SERVICE_URL_ORDERS');
    expect(serviceUrlEnv('stock-ledger')).toBe('SERVICE_URL_STOCK_LEDGER');
  });
});

describe('gateReachableUrl', () => {
  it.each([
    ['http://127.0.0.1:3000', 'http://host.docker.internal:3000/'],
    ['http://localhost:3000/api', 'http://host.docker.internal:3000/api'],
    ['http://[::1]:8080', 'http://host.docker.internal:8080/'],
    ['http://0.0.0.0:3000', 'http://host.docker.internal:3000/'],
  ])('points the container at the host instead of its own loopback: %s', (from, to) => {
    expect(gateReachableUrl(from)).toBe(to);
  });

  it('leaves a non-loopback address alone', () => {
    expect(gateReachableUrl('http://10.0.0.5:3000')).toBe('http://10.0.0.5:3000');
    expect(gateReachableUrl('http://todo-api.teams-ai.svc:3000')).toBe('http://todo-api.teams-ai.svc:3000');
  });
});

describe('runSmoke secrets', () => {
  it('hands the suite the secrets the spec declares, once and by name only', async () => {
    const spec = { ...makeFrozenSpec(), acceptanceCriteria: makeFrozenSpec().acceptanceCriteria.map((ac, i) => ({ ...ac, smoke: i === 0 })) };
    const ctx: GateContext = { worktree: '/w', image: 'node:22-bookworm', junitPath: 'reports/junit.xml', cpus: 2, memory: '2g', timeoutMs: 1000, secrets: { PLATFORM_ADMIN_TOKEN: 't'.repeat(32) }, containerName: 'c' };
    const exec = new FakeExec();
    await runSmoke(makePlan(spec), spec, ctx, 'http://app:3000', { exec: exec.exec, readFile: async () => null, removeFile: async () => undefined });
    const call = exec.calls.find((c) => c.args[0] === 'run')!;
    expect(call.env).toMatchObject({ PLATFORM_ADMIN_TOKEN: 't'.repeat(32), SERVICE_URL: 'http://app:3000' });
    expect(call.args.filter((a) => a === 'PLATFORM_ADMIN_TOKEN')).toHaveLength(1);
    expect(call.args.join(' ')).not.toContain('t'.repeat(32));
  });
});
