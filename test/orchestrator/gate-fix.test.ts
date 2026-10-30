import { describe, expect, it } from 'vitest';
import type { Gate } from '../../server/contracts/plan.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { applyGateFixes, effectivePlan, gateFixErrors, gateFixes, gateImageErrors, gateImageFixes, MAX_GATE_FIXES } from '../../server/orchestrator/gate-fix.js';
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

const imageFixed = (service: string | null, before: string, after: string) => ({ type: OrchEvent.GateImageFixed, data: { service, before, after, reason: 'test' } });

describe('gate image fixes journaled for a repository', () => {
  it('keeps the image changes of one repository in order, and the last one wins', () => {
    const events = [imageFixed(null, 'golang:1.27.2-bookworm', 'golang:1.27.3-bookworm'), imageFixed('api', 'node:22-bookworm', 'node:22.1-bookworm'), imageFixed(null, 'golang:1.27.3-bookworm', 'golang:1.27.4-bookworm')];
    expect(gateImageFixes(events, null).map((f) => f.after)).toEqual(['golang:1.27.3-bookworm', 'golang:1.27.4-bookworm']);
    expect(effectivePlan(plan, events, null).gateImage).toBe('golang:1.27.4-bookworm');
    expect(effectivePlan(plan, events, 'api').gateImage).toBe('node:22.1-bookworm');
  });

  it('applies command fixes and image fixes together, and returns the plan itself when nothing was fixed', () => {
    const events = [fixed(null, 'coverage', 'npm run coverage', 'B'), imageFixed(null, plan.gateImage, 'node:22.99-bookworm')];
    const out = effectivePlan(plan, events, null);
    expect(out.gates[0]!.command).toBe('B');
    expect(out.gateImage).toBe('node:22.99-bookworm');
    expect(effectivePlan(plan, [], null)).toBe(plan);
  });
});

describe('gate image fix errors', () => {
  const GO = 'golang:1.27.2-bookworm';

  it('accepts a newer version of the same image and flavour', () => {
    expect(gateImageErrors(GO, 'golang:1.27.3-bookworm', 0)).toEqual([]);
    expect(gateImageErrors(GO, 'golang:1.28.0-bookworm', 0)).toEqual([]);
  });

  it('refuses another image, another flavour or a downgrade', () => {
    expect(gateImageErrors(GO, 'node:22-bookworm', 0)).toEqual(['the gate image keeps its repository: golang, not node']);
    expect(gateImageErrors(GO, 'golang:1.27.3-alpine', 0)).toEqual(['the gate image keeps its flavour: -bookworm, not -alpine']);
    expect(gateImageErrors(GO, 'golang:1.27.1-bookworm', 0)).toEqual(['the gate image only moves to a newer version: 1.27.2 to 1.27.1']);
  });

  it('says the gate image already runs the same tag instead of asking for a newer version', () => {
    expect(gateImageErrors(GO, GO, 0)).toEqual([`the gate image already runs ${GO}`]);
    expect(gateImageErrors(GO, GO, MAX_GATE_FIXES)).toEqual([`the gate image already runs ${GO}`]);
  });

  it('refuses a tag-less, digest-pinned or malformed reference', () => {
    expect(gateImageErrors(GO, 'golang', 0)).toEqual(['the gate image needs a version tag such as golang:1.27.3-bookworm']);
    expect(gateImageErrors(GO, `golang:1.27.3-bookworm@sha256:${'a'.repeat(64)}`, 0)).toEqual(['the gate image needs a version tag such as golang:1.27.3-bookworm']);
    expect(gateImageErrors(GO, '-golang:1.27.3', 0)).toEqual(['"-golang:1.27.3" is not a plain image reference']);
  });

  it('refuses a change past the limit', () => {
    expect(gateImageErrors(GO, 'golang:1.27.3-bookworm', MAX_GATE_FIXES)).toEqual([`the gate image was already changed ${MAX_GATE_FIXES} time(s) in this run`]);
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
