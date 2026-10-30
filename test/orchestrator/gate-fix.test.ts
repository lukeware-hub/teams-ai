import { describe, expect, it } from 'vitest';
import type { Gate } from '../../server/contracts/plan.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { applyGateFixes, gateFixErrors, gateFixes, MAX_GATE_FIXES } from '../../server/orchestrator/gate-fix.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const gate = (name: string, command: string, blocking = true): Gate => ({ name, command, blocking, network: 'none', secrets: [] });
const plan = makePlan(spec, { gates: [gate('coverage', 'npm run coverage'), gate('lint', 'npm run lint'), gate('e2e', 'npm run e2e'), gate('notes', 'npm run notes', false)] });
const fixed = (service: string | null, name: string, before: string, after: string) => ({ type: OrchEvent.GateFixed, data: { service, gate: name, before, after, reason: 'test' } });

describe('gate fixes journaled for a repository', () => {
  it('keeps the corrections of one repository in order, and the last one per gate wins', () => {
    const events = [fixed(null, 'coverage', 'npm run coverage', 'A'), fixed('api', 'lint', 'npm run lint', 'other'), fixed(null, 'coverage', 'A', 'B')];
    const fixes = gateFixes(events, null);
    expect(fixes.map((f) => f.command)).toEqual(['A', 'B']);
    expect(applyGateFixes(plan, fixes).gates.map((g) => g.command)).toEqual(['B', 'npm run lint', 'npm run e2e', 'npm run notes']);
  });

  it('returns the plan itself when nothing was corrected', () => {
    expect(applyGateFixes(plan, [])).toBe(plan);
  });
});

describe('gate fix errors', () => {
  const fix = (name: string, command: string) => ({ gate: name, command });

  it('accepts a corrected command for a blocking gate', () => {
    expect(gateFixErrors(plan, fix('coverage', 'npm run coverage -- --json'), 0)).toEqual([]);
  });

  it('refuses a gate the plan does not have', () => {
    expect(gateFixErrors(plan, fix('security', 'npm run security'), 0)).toEqual(['no gate named security in this plan']);
  });

  it('refuses the e2e gate, which runs after deploy', () => {
    expect(gateFixErrors(plan, fix('e2e', 'npm run e2e -- --x'), 0)).toEqual(['gate e2e runs after deploy, outside the task gates']);
  });

  it('refuses a gate that is not blocking', () => {
    expect(gateFixErrors(plan, fix('notes', 'npm run notes -- --x'), 0)).toEqual(['gate notes is not blocking']);
  });

  it('refuses a command the gate already runs', () => {
    expect(gateFixErrors(plan, fix('lint', ' npm run lint '), 0)).toEqual(['gate lint already runs this command']);
  });

  it('refuses a command that disarms its check', () => {
    expect(gateFixErrors(plan, fix('coverage', 'npm run coverage || true'), 0)).toEqual(['gate coverage would pass without its check (|| true, exit 0 or an exit-zero flag)']);
  });

  it('refuses a correction past the limit for one gate', () => {
    expect(gateFixErrors(plan, fix('coverage', 'npm run coverage -- --json'), MAX_GATE_FIXES)).toEqual([`gate coverage was already corrected ${MAX_GATE_FIXES} time(s) in this run`]);
  });
});
