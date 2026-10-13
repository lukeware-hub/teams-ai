import type { Gate, Plan } from '../contracts/plan.js';
import type { Spec } from '../contracts/spec.js';
import type { TestResult } from '../evidence/junit.js';
import { runGate, type GateContext, type GateDeps, type GateResult } from './gate-runner.js';

/** Name of the post-deploy e2e gate (roadmap R8.4); it is never run as a per-task gate. */
export const E2E_GATE = 'e2e';

export interface E2eRow { acId: string; testId: string | null; status: 'passed' | 'failed' | 'missing' | 'not-applicable'; reason?: string; }

/** commands.e2e wins; a plan gate named `e2e` is the fallback command. */
export function e2eCommand(plan: Plan): string | undefined {
  return plan.commands.e2e ?? plan.gates.find((g) => g.name === E2E_GATE)?.command;
}

export function e2eGate(plan: Plan): Gate | null {
  const command = e2eCommand(plan);
  return command ? { name: E2E_GATE, command, blocking: true, network: 'egress', secrets: ['SERVICE_URL'] } : null;
}

/** One row per acceptance criterion: the e2e suite carries one `[AC-xxx]` test for each. */
export function evaluateE2e(spec: Spec, junit: readonly TestResult[] | null, exemptions: readonly { acId: string; reason: string }[] = []) {
  const rows: E2eRow[] = spec.acceptanceCriteria.map((ac) => {
    const exempt = exemptions.find((x) => x.acId === ac.id);
    if (exempt) return { acId: ac.id, testId: null, status: 'not-applicable' as const, reason: exempt.reason };
    const tests = (junit ?? []).filter((t) => t.acIds.includes(ac.id) && t.status !== 'skipped');
    const failed = tests.find((t) => t.status === 'failed');
    if (failed) return { acId: ac.id, testId: failed.id, status: 'failed' as const };
    const passed = tests.find((t) => t.status === 'passed');
    return passed ? { acId: ac.id, testId: passed.id, status: 'passed' as const } : { acId: ac.id, testId: null, status: 'missing' as const };
  });
  const bad = rows.filter((r) => r.status !== 'passed' && r.status !== 'not-applicable');
  return bad.length ? { ok: false, rows, detail: bad.map((r) => `${r.acId}: ${r.status === 'failed' ? 'failed' : 'no e2e test'}`).join('; ') } : { ok: true, rows, detail: `${rows.filter((r) => r.status === 'passed').length}/${rows.length - rows.filter((r) => r.status === 'not-applicable').length} e2e criteria passed` };
}

export async function runE2e(plan: Plan, spec: Spec, ctx: GateContext, serviceUrl: string, deps: GateDeps, urls: Readonly<Record<string, string>> = {}): Promise<{ ok: boolean; rows: E2eRow[]; detail: string; result: GateResult | null }> {
  const gate = e2eGate(plan);
  if (!gate) return { ok: false, rows: evaluateE2e(spec, null, plan.e2eExemptions).rows, detail: 'plan.commands.e2e missing', result: null };
  const result = await runGate({ ...gate, secrets: [...new Set([...gate.secrets, ...Object.keys(ctx.secrets), ...Object.keys(urls)])] }, { ...ctx, secrets: { ...ctx.secrets, SERVICE_URL: serviceUrl, ...urls } }, deps);
  const evaluated = evaluateE2e(spec, result.junit, plan.e2eExemptions);
  if (!result.passed && evaluated.ok) return { ok: false, rows: evaluated.rows, detail: `e2e command exited ${result.exitCode ?? 'null'}${result.timedOut ? ' (timeout)' : ''}`, result };
  return { ...evaluated, result };
}
