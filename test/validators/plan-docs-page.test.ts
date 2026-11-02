import { describe, expect, it } from 'vitest';
import { asksForDocsPage, docsPageErrors } from '../../server/validators/docs-page.js';
import { validatePlan } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlan, makePlanTask } from '../fixtures/contracts.js';

const asking = makeFrozenSpec({ features: ['Swagger documentation of the API at /docs'] });
const plain = makeFrozenSpec();
const built = [makePlanTask({ id: 'T4-docs', description: 'Serve the Swagger page at /docs', affectedPaths: ['src/docs/**'] })];
const declared = { kind: 'api' as const, docsPath: '/docs' };

describe('asksForDocsPage', () => {
  it('reads a request for Swagger, OpenAPI or the API documentation in the spec', () => {
    expect(asksForDocsPage(asking)).toBe(true);
    expect(asksForDocsPage(makeFrozenSpec({ objectives: ['Publish the OpenAPI description'] }))).toBe(true);
    expect(asksForDocsPage(makeFrozenSpec({ features: ['Documentação da API em /docs'] }))).toBe(true);
  });

  it('reads a refusal of the page as no request', () => {
    expect(asksForDocsPage(makeFrozenSpec({ features: ['Não expor Swagger'] }))).toBe(false);
    const refused = makeFrozenSpec({ acceptanceCriteria: [{ id: 'AC-001', given: 'a client', when: 'it GETs /docs', then: 'the API answers 404', smoke: false }] });
    expect(asksForDocsPage(refused)).toBe(false);
  });

  it('reads a spec that never names the page as no request', () => {
    expect(asksForDocsPage(plain)).toBe(false);
  });
});

describe('docsPageErrors', () => {
  it('passes when the spec asks, the plan declares the path and a task builds the page', () => {
    expect(docsPageErrors(declared, built, asking)).toEqual([]);
  });

  it('asks for the declared path when the spec asks and the plan has none', () => {
    expect(docsPageErrors({ kind: 'api' }, built, asking)).toEqual([expect.stringContaining('the spec asks for a documentation page, so deploy.docsPath must name it')]);
  });

  it('needs a task that builds the declared page', () => {
    const others = [makePlanTask({ id: 'T1-create', description: 'Create a todo' })];
    expect(docsPageErrors(declared, others, asking)).toEqual([expect.stringContaining('no task builds the documentation page at /docs')]);
  });

  it('refuses a declared path the spec does not ask for', () => {
    expect(docsPageErrors(declared, built, plain)).toEqual([expect.stringContaining('the spec asks for no documentation page; remove it')]);
  });

  it('passes a plan with no path for a spec that asks for none', () => {
    expect(docsPageErrors({ kind: 'api' }, built, plain)).toEqual([]);
  });

  it('exempts a mobile deploy, which has no service page', () => {
    expect(docsPageErrors({ kind: 'mobile', docsPath: '/docs' }, built, plain)).toEqual([]);
  });
});

describe('validatePlan and the documentation page', () => {
  const deploy = { image: 'todo-api', port: 3000, healthcheckPath: '/health', manifests: ['deploy/k8s.yaml'], kind: 'api' as const };

  it('rejects a plan that leaves out the page the spec asks for', () => {
    const errors = validatePlan(makePlan(asking, { deploy }), asking, { firstSpec: true });
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('the spec asks for a documentation page')]));
  });

  it('accepts a plan that declares the page and builds it', () => {
    const tasks = [...makePlan(asking).tasks, ...built];
    const errors = validatePlan(makePlan(asking, { deploy: { ...deploy, docsPath: '/docs' }, tasks }), asking, { firstSpec: true });
    expect(errors.filter((e) => /documentation|docsPath/.test(e))).toEqual([]);
  });

  it('rejects a declared path for a spec that asks for none', () => {
    const errors = validatePlan(makePlan(plain, { deploy: { ...deploy, docsPath: '/docs' } }), plain, { firstSpec: true });
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('the spec asks for no documentation page')]));
  });
});
