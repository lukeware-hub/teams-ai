import type { Gate, Plan } from '../contracts/plan.js';
import type { Spec } from '../contracts/spec.js';
import type { TestResult } from '../evidence/junit.js';
import { runGate, type GateContext, type GateDeps, type GateResult } from './gate-runner.js';

export interface SmokeRow { acId: string; testId: string | null; status: 'passed' | 'failed' | 'missing'; }

export function smokeGate(plan: Plan): Gate | null {
  return plan.commands.smoke ? { name: 'smoke', command: plan.commands.smoke, blocking: true, network: 'egress', secrets: ['SERVICE_URL'] } : null;
}

/** The smoke gate runs in a container, where 127.0.0.1 is the container itself: point a loopback service URL at the host. */
export function gateReachableUrl(serviceUrl: string): string {
  const u = new URL(serviceUrl);
  if (!['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(u.hostname)) return serviceUrl;
  u.hostname = 'host.docker.internal';
  return u.toString();
}

export function evaluateSmoke(spec: Spec, junit: readonly TestResult[] | null) {
  const rows: SmokeRow[] = spec.acceptanceCriteria.filter((ac) => ac.smoke).map((ac) => {
    const tests = (junit ?? []).filter((t) => t.acIds.includes(ac.id) && t.status !== 'skipped');
    const failed = tests.find((t) => t.status === 'failed');
    if (failed) return { acId: ac.id, testId: failed.id, status: 'failed' as const };
    const passed = tests.find((t) => t.status === 'passed');
    return passed ? { acId: ac.id, testId: passed.id, status: 'passed' as const } : { acId: ac.id, testId: null, status: 'missing' as const };
  });
  const bad = rows.filter((r) => r.status !== 'passed');
  return bad.length ? { ok: false, rows, detail: bad.map((r) => `${r.acId}: ${r.status === 'failed' ? 'failed' : 'no smoke test'}`).join('; ') } : { ok: true, rows, detail: `${rows.length}/${rows.length} smoke criteria passed` };
}

export async function runSmoke(plan: Plan, spec: Spec, ctx: GateContext, serviceUrl: string, deps: GateDeps): Promise<{ ok: boolean; rows: SmokeRow[]; detail: string; result: GateResult | null }> {
  if (!spec.acceptanceCriteria.some((ac) => ac.smoke)) return { ok: true, rows: [], detail: 'no smoke criteria', result: null };
  const gate = smokeGate(plan);
  if (!gate) return { ok: false, rows: evaluateSmoke(spec, null).rows, detail: 'plan.commands.smoke missing', result: null };
  const result = await runGate(gate, { ...ctx, secrets: { ...ctx.secrets, SERVICE_URL: serviceUrl } }, deps);
  const evaluated = evaluateSmoke(spec, result.junit);
  if (!result.passed && evaluated.ok) return { ok: false, rows: evaluated.rows, detail: `smoke command exited ${result.exitCode ?? 'null'}${result.timedOut ? ' (timeout)' : ''}`, result };
  return { ...evaluated, result };
}
