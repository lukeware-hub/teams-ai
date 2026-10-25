import { describe, expect, it } from 'vitest';
import { Plan } from '../../server/contracts/plan.js';
import { validatePlan } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const apk = 'build/app/outputs/flutter-apk/app-debug.apk';
const base = makePlan(spec);
const { image: _image, port: _port, healthcheckPath: _path, ...withoutContainer } = base.deploy;
/** The raw plan with its deploy replaced, before the schema reads it. */
const withDeploy = (deploy: Record<string, unknown>) => ({ ...base, deploy: { ...withoutContainer, ...deploy } });

describe('a mobile plan ships an artifact, not a container', () => {
  it('parses with no image, port or healthcheck, and names its artifact', () => {
    expect(Plan.safeParse(withDeploy({ kind: 'mobile', artifact: apk })).success).toBe(true);
  });

  it('refuses a mobile plan that names no artifact', () => {
    expect(Plan.safeParse(withDeploy({ kind: 'mobile' })).success).toBe(false);
  });

  it('refuses an api plan that lacks its container fields', () => {
    expect(Plan.safeParse(withDeploy({ kind: 'api' })).success).toBe(false);
  });

  it('asks for no delivery files and no e2e suite', () => {
    const plan = Plan.parse(withDeploy({ kind: 'mobile', artifact: apk }));
    const errors = validatePlan(plan, spec, { firstSpec: true, requireDelivery: true, requireE2e: true }).join('\n');
    expect(errors).not.toMatch(/delivery is required/);
    expect(errors).not.toMatch(/commands\.e2e is required/);
    expect(errors).not.toMatch(/deploy\.port/);
  });
});
