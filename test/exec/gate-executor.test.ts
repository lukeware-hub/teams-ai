import { describe, expect, it } from 'vitest';
import { Config } from '../../server/config/config.js';
import { Gate as GateSchema } from '../../server/contracts/plan.js';
import { createGateExecutor } from '../../server/exec/gate-executor.js';
import { runGate, type GateContext } from '../../server/exec/gate-runner.js';
import { K8sGateExecutor } from '../../server/exec/k8s-gate-executor.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const ctx: GateContext = { worktree: '/w/t', image: 'img', junitPath: 'j.xml', cpus: 1, memory: '1g', timeoutMs: 1000, secrets: {}, containerName: 'c' };
const gate = GateSchema.parse({ name: 'g', command: 'true', blocking: true });

describe('gate executor selection', () => {
  it('defaults to docker in the config', () => {
    const cfg = Config.parse({});
    expect(cfg.executor.kind).toBe('docker');
    expect(cfg.executor.namespace).toBe('teams-ai');
    expect(createGateExecutor(cfg.executor, new FakeExec().exec).kind).toBe('docker');
  });

  it('selects k8s only when configured', () => {
    const cfg = Config.parse({ executor: { kind: 'k8s' } });
    expect(createGateExecutor(cfg.executor, new FakeExec().exec)).toBeInstanceOf(K8sGateExecutor);
  });

  it('runGate without an executor still calls docker run', async () => {
    const fake = new FakeExec();
    await runGate(gate, ctx, { exec: fake.exec, readFile: async () => null, removeFile: async () => undefined });
    expect(fake.calls[0]).toMatchObject({ bin: 'docker' });
    expect(fake.calls[0]!.args[0]).toBe('run');
  });
});
