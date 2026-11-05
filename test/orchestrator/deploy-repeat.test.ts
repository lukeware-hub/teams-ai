import { describe, expect, it } from 'vitest';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { failureSignature, repeatedDeployCause } from '../../server/orchestrator/phases/deploy.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const failed = (attempt: number, stage: string, detail: string, service?: string): StoredEvent => ({
  seq: attempt, at: '2026-11-05T10:00:00.000Z', runId: 'r1', specHash: 'h', type: OrchEvent.DeployFailed, kind: 'fact',
  data: { attempt, stage, detail, ...(service ? { service } : {}) },
});

describe('failureSignature', () => {
  it('is the failing tests a suite names, so the same tests with other timings are the same cause', () => {
    expect(failureSignature('e2e command exited 1\n    --- FAIL: TestE2E/[AC-014]_x (2.54s)\n--- FAIL: TestRegisterUserControl (2.29s)')).toBe('TestE2E/[AC-014]_x | TestRegisterUserControl');
  });

  it('is the first line of a failure that names no test', () => {
    expect(failureSignature('dial tcp: lookup host: no such host\nmore detail')).toBe('dial tcp: lookup host: no such host');
  });
});

describe('repeatedDeployCause', () => {
  const now = { stage: 'e2e', service: null, detail: 'e2e command exited 1\n--- FAIL: TestE2E/[AC-014]_x (1s)' };

  it('finds the earlier failure with the same stage, service and failing tests', () => {
    const earlier = [failed(1, 'e2e', 'e2e command exited 1\n--- FAIL: TestE2E/[AC-014]_x (9s)')];
    expect(repeatedDeployCause(earlier, now)?.data.attempt).toBe(1);
  });

  it('is null when the stage, the service or the failing tests differ', () => {
    expect(repeatedDeployCause([failed(1, 'smoke', now.detail)], now)).toBeNull();
    expect(repeatedDeployCause([failed(1, 'e2e', now.detail, 'hello-world-api')], now)).toBeNull();
    expect(repeatedDeployCause([failed(1, 'e2e', 'e2e command exited 1\n--- FAIL: TestE2E/[AC-034]_y')], now)).toBeNull();
  });

  it('is null with no earlier failure', () => {
    expect(repeatedDeployCause([], now)).toBeNull();
  });
});
