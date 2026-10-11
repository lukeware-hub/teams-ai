import { describe, expect, it } from 'vitest';
import { e2eGate, evaluateE2e, runE2e } from '../../server/exec/e2e.js';
import { parseJUnit } from '../../server/evidence/junit.js';
import type { GateContext, GateDeps } from '../../server/exec/gate-runner.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const plan = makePlan(spec, { commands: { ...makePlan(spec).commands, e2e: 'npx vitest run e2e/' } });
const ctx: GateContext = { worktree: '/w', image: 'node:22-bookworm', junitPath: 'reports/junit.xml', cpus: 2, memory: '2g', timeoutMs: 1000, secrets: {}, containerName: 'c' };
const junit = (cases: string) => `<testsuite name="e2e">${cases}</testsuite>`;
const ok = (ac: string) => `<testcase classname="e2e" name="[${ac}] works"/>`;
const bad = (ac: string) => `<testcase classname="e2e" name="[${ac}] breaks"><failure/></testcase>`;
const deps = (exec: FakeExec, xml: string | null): GateDeps => ({ exec: exec.exec, readFile: async () => xml, removeFile: async () => undefined });

describe('e2e rows per acceptance criterion', () => {
  it('keys one row per AC: passed, failed and missing', () => {
    const r = evaluateE2e(spec, parseJUnit(junit(ok('AC-001'))));
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([{ acId: 'AC-001', testId: 'e2e::[AC-001] works', status: 'passed' }, { acId: 'AC-002', testId: null, status: 'missing' }]);
    expect(r.detail).toBe('AC-002: no e2e test');
    expect(evaluateE2e(spec, parseJUnit(junit(ok('AC-001') + bad('AC-002')))).detail).toBe('AC-002: failed');
  });

  it('covers every criterion, not only the smoke ones', () => {
    const r = evaluateE2e(spec, parseJUnit(junit(ok('AC-001') + ok('AC-002'))));
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.acId)).toEqual(['AC-001', 'AC-002']);
  });
});

describe('runE2e', () => {
  it("passes the other services' addresses to the suite like SERVICE_URL", async () => {
    const exec = new FakeExec();
    await runE2e(plan, spec, ctx, 'http://inventory:3000', deps(exec, junit(ok('AC-001') + ok('AC-002'))), { SERVICE_URL_ORDERS: 'http://orders:3000' });
    const call = exec.calls[0]!;
    expect(call.env).toMatchObject({ SERVICE_URL: 'http://inventory:3000', SERVICE_URL_ORDERS: 'http://orders:3000' });
    expect(call.args.join(' ')).toContain('-e SERVICE_URL_ORDERS');
  });

  it('builds a blocking egress gate that receives SERVICE_URL like a secret', () => {
    expect(e2eGate(plan)).toMatchObject({ name: 'e2e', blocking: true, network: 'egress', secrets: ['SERVICE_URL'] });
    expect(e2eGate(makePlan(spec))).toBeNull();
  });

  it('passes when every criterion has a passing test, and injects SERVICE_URL and the compose network', async () => {
    const exec = new FakeExec();
    const r = await runE2e(plan, spec, { ...ctx, network: 'proj_default' }, 'http://app:3000', deps(exec, junit(ok('AC-001') + ok('AC-002'))));
    expect(r.ok).toBe(true);
    const call = exec.calls[0]!;
    expect(call.env?.SERVICE_URL).toBe('http://app:3000');
    expect(call.args.join(' ')).toContain('--network proj_default');
  });

  it('names the failing criterion from the TAP output when the suite exits non-zero without a junit report', async () => {
    const tap = 'TAP version 13\nok 1 - [AC-001] works\nnot ok 2 - [AC-002] breaks\n1..2\n';
    const exit1 = new FakeExec().on(() => true, () => ({ exitCode: 1, stdout: tap }));
    expect((await runE2e(plan, spec, ctx, 'http://x', deps(exit1, null))).detail).toBe('AC-002: failed');
  });

  it('fails on a failing test, on a non-zero exit with clean junit, and with no e2e command', async () => {
    expect((await runE2e(plan, spec, ctx, 'http://x', deps(new FakeExec(), junit(ok('AC-001') + bad('AC-002'))))).detail).toBe('AC-002: failed');
    const exit1 = new FakeExec().on(() => true, () => ({ exitCode: 1 }));
    expect((await runE2e(plan, spec, ctx, 'http://x', deps(exit1, junit(ok('AC-001') + ok('AC-002'))))).detail).toBe('e2e command exited 1');
    expect((await runE2e(makePlan(spec), spec, ctx, 'http://x', deps(new FakeExec(), null))).detail).toBe('plan.commands.e2e missing');
  });
});

describe('e2e exemptions', () => {
  const ex = [{ acId: 'AC-002', reason: 'devops-only criterion, no HTTP behavior' }];
  it('skips an exempted criterion and keeps the reason in the row', () => {
    const r = evaluateE2e(spec, parseJUnit(junit(ok('AC-001'))), ex);
    expect(r.ok).toBe(true);
    expect(r.rows[1]).toEqual({ acId: 'AC-002', testId: null, status: 'not-applicable', reason: ex[0]!.reason });
    expect(r.detail).toBe('1/1 e2e criteria passed');
  });
  it('still fails a non-exempted missing criterion', () => {
    expect(evaluateE2e(spec, parseJUnit(junit(ok('AC-002'))), ex).detail).toBe('AC-001: no e2e test');
  });
  it('runE2e honours plan.e2eExemptions', async () => {
    const p = { ...plan, e2eExemptions: ex };
    const r = await runE2e(p, spec, ctx, 'http://x', deps(new FakeExec(), junit(ok('AC-001'))));
    expect(r.ok).toBe(true);
  });
});
