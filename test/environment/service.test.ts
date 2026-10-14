import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EnvironmentVariable } from '../../server/agents/outputs.js';
import type { Plan } from '../../server/contracts/plan.js';
import { citedVariables, mintEnvironment, MISSING_VARIABLE, prepareEnvironment, type EnvironmentHost } from '../../server/environment/service.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';

let root: string;
let repoDir: string;
const plan = { delivery: { compose: 'docker-compose.yml', e2eSuite: 'e2e/' } } as unknown as Plan;
const random = (name: string, scope: EnvironmentVariable['scope'] = 'both'): EnvironmentVariable => ({ name, scope, strategy: 'random', reason: 'lido no compose' });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-envsvc-'));
  repoDir = path.join(root, 'repo');
  await mkdir(path.join(repoDir, 'e2e'), { recursive: true });
  await writeFile(path.join(repoDir, 'docker-compose.yml'), 'services:\n  app:\n    environment:\n      - POSTGRES_PASSWORD\n');
  await writeFile(path.join(repoDir, 'e2e', 'a_test.go'), 'os.Getenv("E2E_AUTHORIZATION")');
});

function host(answer: (wanted: string[], feedback: string) => EnvironmentVariable[] | 'fail', secrets: Record<string, string> = {}) {
  const spec = makeFrozenSpec();
  const calls: Array<{ kind: string; role: string; feedback: string; cwd: string }> = [];
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const provided: Array<Record<string, string>> = [];
  const h: EnvironmentHost = {
    projectId: 'shop', specId: 'spec-001', secretsDir: path.join(root, 'secrets'), manifestDir: path.join(root, 'environment'),
    secrets, suiteNames: new Set<string>(), services: ['identity-service'],
    target: { provide: (env) => void provided.push({ ...env }), serviceEnv: async () => null },
    runAgent: (async (req: { kind: string; role: string; cwd: string; pack: { feedback?: string } }) => {
      const feedback = req.pack.feedback ?? '';
      calls.push({ kind: req.kind, role: req.role, feedback, cwd: req.cwd });
      const wanted = [...feedback.matchAll(/^- ([A-Z][A-Z0-9_]*): read in/gm)].map((m) => m[1]!);
      const r = answer(wanted, feedback);
      return r === 'fail' ? { ok: false, failure: 'schema', errors: ['bad'], summary: {} } : { ok: true, value: { specHash: spec.specHash, variables: r, notes: '' }, summary: {} };
    }) as never,
    packBase: () => ({ spec, project: makeProject(), specHash: spec.specHash!, assumptions: [], budgetTokens: 8000 }),
    pause: async () => false,
    journal: { fact: async (type, data) => void events.push({ type, data }) },
  };
  return { h, calls, events, provided };
}

describe('prepareEnvironment', () => {
  it('asks the agent only for what nothing provides, creates it and hands it to the compose and the suites', async () => {
    const { h, calls, events, provided } = host((wanted) => wanted.map((n) => random(n, n === 'E2E_AUTHORIZATION' ? 'suites' : 'compose')));
    expect(await prepareEnvironment(h, { service: null, dir: repoDir, plan })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'environment', role: 'env', cwd: repoDir });
    expect(calls[0]!.feedback).toContain('- POSTGRES_PASSWORD: read in docker-compose.yml');
    expect(calls[0]!.feedback).toContain('- E2E_AUTHORIZATION: read in e2e/a_test.go');
    expect(h.secrets.POSTGRES_PASSWORD).toHaveLength(32);
    expect((await readFile(path.join(root, 'secrets', 'POSTGRES_PASSWORD'), 'utf8')).trim()).toBe(h.secrets.POSTGRES_PASSWORD);
    expect(provided).toEqual([{ POSTGRES_PASSWORD: h.secrets.POSTGRES_PASSWORD }]);
    expect([...h.suiteNames]).toEqual(['E2E_AUTHORIZATION']);
    expect(events.map((e) => e.type)).toEqual(['ENVIRONMENT_PLANNED']);
    expect(JSON.stringify(events)).not.toContain(h.secrets.POSTGRES_PASSWORD!);
  });

  it('never asks again once the recipes are remembered, and still hands the values over in a later run', async () => {
    const first = host((wanted) => wanted.map((n) => random(n)));
    await prepareEnvironment(first.h, { service: null, dir: repoDir, plan });
    // A new run: the secrets come back from disk, the recipes from the manifest, and the agent is not asked.
    const second = host(() => { throw new Error('the agent must not be asked'); }, { ...first.h.secrets });
    expect(await prepareEnvironment(second.h, { service: null, dir: repoDir, plan })).toBe(false);
    expect(second.calls).toHaveLength(0);
    expect(second.provided).toEqual([{ POSTGRES_PASSWORD: first.h.secrets.POSTGRES_PASSWORD, E2E_AUTHORIZATION: first.h.secrets.E2E_AUTHORIZATION }]);
    expect([...second.h.suiteNames].sort()).toEqual(['E2E_AUTHORIZATION', 'POSTGRES_PASSWORD']);
  });

  it('does not call the agent when every variable exists', async () => {
    const { h, calls } = host(() => 'fail', { POSTGRES_PASSWORD: 'x', E2E_AUTHORIZATION: 'y' });
    expect(await prepareEnvironment(h, { service: null, dir: repoDir, plan })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('takes a variable the failure names even when the files do not show it, and ignores a name nobody asked for', async () => {
    const { h, calls } = host((wanted, feedback) => (feedback.includes('KMS_MASTER_KEY') ? [random('KMS_MASTER_KEY'), random('NOT_ASKED_FOR')] : wanted.map((n) => random(n))), { POSTGRES_PASSWORD: 'x', E2E_AUTHORIZATION: 'y' });
    const changed = await prepareEnvironment(h, { service: null, dir: repoDir, plan }, 'e2e: KMS_MASTER_KEY não foram definidos');
    expect(changed).toBe(true);
    expect(calls[0]!.feedback).toContain('KMS_MASTER_KEY');
    expect(calls[0]!.feedback).toContain('e2e: KMS_MASTER_KEY não foram definidos');
    expect(Object.keys(h.secrets).sort()).toEqual(['E2E_AUTHORIZATION', 'KMS_MASTER_KEY', 'POSTGRES_PASSWORD']);
  });

  it('creates nothing when the agent fails, so the deploy goes on and fails with its own message', async () => {
    const { h, events } = host(() => 'fail');
    expect(await prepareEnvironment(h, { service: null, dir: repoDir, plan })).toBe(false);
    expect(h.secrets).toEqual({});
    expect(events).toEqual([]);
  });
});

describe('mintEnvironment', () => {
  it('asks the deployed services for the values only they issue and makes them readable by the suites', async () => {
    await writeFile(path.join(repoDir, 'e2e', 'b_test.go'), 'os.Getenv("PLATFORM_ADMIN_TOKEN")');
    const mint: EnvironmentVariable = { name: 'E2E_AUTHORIZATION', scope: 'suites', reason: 'sessão', strategy: 'mint', service: 'identity-service', request: { method: 'POST', path: '/v1/sessions', headers: { authorization: 'Bearer ${PLATFORM_ADMIN_TOKEN}' } }, extract: { from: 'json', path: 'token' }, template: 'Bearer {value}' };
    const { h, events } = host((wanted) => wanted.map((n) => (n === 'E2E_AUTHORIZATION' ? mint : random(n))));
    await prepareEnvironment(h, { service: null, dir: repoDir, plan });
    expect(h.secrets.E2E_AUTHORIZATION).toBeUndefined();
    const admin = h.secrets.PLATFORM_ADMIN_TOKEN!;
    h.fetch = (async (_u: URL, init: RequestInit) => new Response(JSON.stringify({ token: (init.headers as Record<string, string>).authorization === `Bearer ${admin}` ? 'minted' : 'denied' }))) as unknown as typeof fetch;
    h.secrets.GITHUB_TOKEN = 'platform-token';
    await mintEnvironment(h, { 'identity-service': 'http://identity-service:1' });
    expect(h.secrets.E2E_AUTHORIZATION).toBe('Bearer minted');
    expect(h.suiteNames.has('E2E_AUTHORIZATION')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'ENVIRONMENT_MINTED', data: { names: ['E2E_AUTHORIZATION'], failed: [] } });
  });
});

describe('failure signatures', () => {
  it('reads the variable names a failure cites and recognizes a missing-variable failure', () => {
    expect(citedVariables('PLATFORM_ADMIN_TOKEN e SERVICE_URL_IDENTITY_SERVICE não foram definidos; AC_054')).toEqual(['PLATFORM_ADMIN_TOKEN']);
    for (const text of ['required variable POSTGRES_PASSWORD is missing a value', 'missing secret X_KEY', 'gate lint declares secret A_B but it is not available', 'E2E_AUTHORIZATION não foram definidos']) expect(MISSING_VARIABLE.test(text)).toBe(true);
    for (const text of ['AC-001: expected 201, got 500', 'dependency failed to start: container x is unhealthy']) expect(MISSING_VARIABLE.test(text)).toBe(false);
  });
});

describe('mint requests and platform secrets', () => {
  it('lets a request name only the values this environment made up, never a platform secret', async () => {
    const mint: EnvironmentVariable = { name: 'E2E_AUTHORIZATION', scope: 'suites', reason: 'sessão', strategy: 'mint', service: 'identity-service', request: { method: 'GET', path: '/x', headers: { authorization: 'Bearer ${GITHUB_TOKEN}' } }, extract: { from: 'json', path: 'token' } };
    const { h, events } = host((wanted) => wanted.map((n) => (n === 'E2E_AUTHORIZATION' ? mint : random(n))), { GITHUB_TOKEN: 'platform-token' });
    await prepareEnvironment(h, { service: null, dir: repoDir, plan });
    let sent = false;
    h.fetch = (async () => ((sent = true), new Response('{"token":"x"}'))) as unknown as typeof fetch;
    await mintEnvironment(h, { 'identity-service': 'http://identity-service:1' });
    expect(sent).toBe(false);
    expect(h.secrets.E2E_AUTHORIZATION).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'ENVIRONMENT_MINTED', data: { names: [], failed: [{ name: 'E2E_AUTHORIZATION', reason: '${GITHUB_TOKEN} does not exist' }] } });
  });
});

describe('names the platform keeps and services outside the project', () => {
  it('never asks for, nor creates, a variable the platform keeps for itself, even when a suite reads it or a failure names it', async () => {
    await writeFile(path.join(repoDir, 'e2e', 'c_test.go'), 'os.Getenv("ANTHROPIC_API_KEY"); os.Getenv("GITHUB_TOKEN"); os.Getenv("TEAMS_AI_IMAGE_X")');
    const { h, calls } = host((wanted) => wanted.map((n) => random(n)), { POSTGRES_PASSWORD: 'x', E2E_AUTHORIZATION: 'y' });
    expect(await prepareEnvironment(h, { service: null, dir: repoDir, plan }, 'OPENROUTER_API_KEY não foram definidos')).toBe(false);
    expect(calls).toHaveLength(0);
    expect(Object.keys(h.secrets).sort()).toEqual(['E2E_AUTHORIZATION', 'POSTGRES_PASSWORD']);
  });

  it('copies a value only from a service of the project, so the name never reaches the docker command', async () => {
    const asked: string[] = [];
    const { h } = host((wanted) => wanted.map((n): EnvironmentVariable => ({ name: n, scope: 'both', reason: 'x', strategy: 'from-service', service: n === 'POSTGRES_PASSWORD' ? '../etc' : 'identity-service', variable: n })));
    h.target.serviceEnv = async (_p, service) => (asked.push(service), 'running-value');
    await prepareEnvironment(h, { service: null, dir: repoDir, plan });
    expect(asked).toEqual(['identity-service']);
    expect(h.secrets.E2E_AUTHORIZATION).toBe('running-value');
    expect(h.secrets.POSTGRES_PASSWORD).toHaveLength(32);
  });
});
