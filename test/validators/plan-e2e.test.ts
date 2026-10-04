import { describe, expect, it } from 'vitest';
import { Gate } from '../../server/contracts/plan.js';
import { validatePlan } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlan, REQUIRED_GATES } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const delivery = { dockerfile: 'Dockerfile', compose: 'docker-compose.yml', ciWorkflow: '.github/workflows/ci.yml', releaseWorkflow: '.github/workflows/release.yml', e2eSuite: 'e2e/api.e2e.test.ts', readmeSections: ['Run'] };
const base = makePlan(spec).commands;
const plan = (commands: Record<string, string | undefined> = {}, over: Record<string, unknown> = {}) => makePlan(spec, { delivery, commands: { ...base, e2e: 'npx vitest run e2e/api.e2e.test.ts', ...commands } as never, ...over });
const check = (p: ReturnType<typeof plan>) => validatePlan(p, spec, { firstSpec: true, requireE2e: true });

describe('validatePlan requireE2e', () => {
  it('accepts commands.e2e referencing delivery.e2eSuite', () => {
    expect(check(plan())).toEqual([]);
  });

  it('accepts a blocking gate named e2e instead of commands.e2e', () => {
    const gate = Gate.parse({ name: 'e2e', command: 'npx vitest run e2e/api.e2e.test.ts', blocking: true, network: 'egress', secrets: ['SERVICE_URL'] });
    expect(check(plan({ e2e: undefined }, { gates: [...REQUIRED_GATES, gate] }))).toEqual([]);
  });

  it('rejects a plan with no e2e command', () => {
    expect(check(plan({ e2e: undefined }))).toEqual([expect.stringContaining('commands.e2e is required')]);
  });

  it('rejects a non-blocking e2e gate', () => {
    const gate = Gate.parse({ name: 'e2e', command: 'npx vitest run e2e/api.e2e.test.ts', blocking: false });
    expect(check(plan({}, { gates: [...REQUIRED_GATES, gate] }))).toContain('gate e2e must be blocking');
  });

  it('rejects an e2e command that does not reference the delivery suite', () => {
    expect(check(plan({ e2e: 'npm run e2e' })).join()).toContain('must reference delivery.e2eSuite');
  });

  it('rejects the smoke command reused as e2e, and a disarmed command', () => {
    expect(check(plan({ e2e: base.smoke })).join()).toContain('must differ from commands.smoke');
    expect(check(plan({ e2e: 'npx vitest run e2e/api.e2e.test.ts || true' })).join()).toContain('disarmed');
  });

  it('rejects a plan without delivery.e2eSuite', () => {
    expect(check(makePlan(spec, { commands: { ...base, e2e: 'npm run e2e' } as never }))).toContain('delivery.e2eSuite is required when the e2e gate is required');
  });

  it('legacy mode: a plan without e2e stays valid', () => {
    expect(validatePlan(makePlan(spec), spec, { firstSpec: true })).toEqual([]);
    expect(validatePlan(makePlan(spec), spec, { firstSpec: true, requireE2e: false })).toEqual([]);
  });
});

describe('validatePlan e2eExemptions', () => {
  it('accepts an exemption with a reason when another criterion stays covered', () => {
    expect(check(plan({}, { e2eExemptions: [{ acId: 'AC-002', reason: 'devops-only, nothing observable over HTTP' }] }))).toEqual([]);
  });
  it('rejects unknown ids, duplicates, short reasons', () => {
    const errors = check(plan({}, { e2eExemptions: [{ acId: 'AC-009', reason: 'long enough reason' }, { acId: 'AC-002', reason: 'x' }, { acId: 'AC-002', reason: 'long enough reason' }] }));
    expect(errors).toContain('e2eExemptions: AC-009 is not a criterion of the spec');
    expect(errors).toContain('e2eExemptions: duplicate AC-002');
    expect(errors.some((e) => e.includes('needs a reason'))).toBe(true);
  });
  it('rejects exempting every criterion', () => {
    const all = spec.acceptanceCriteria.map((ac) => ({ acId: ac.id, reason: 'not observable over the service' }));
    expect(check(plan({}, { e2eExemptions: all }))).toContain('e2eExemptions: at least one criterion must be covered by the e2e suite');
  });
});
