import { parse, stringify } from 'yaml';
import type { Plan } from '../contracts/plan.js';
import { e2eCommand } from '../exec/e2e.js';
import { stackKind, type StackKind } from '../runner/stacks.js';

/**
 * Deterministic GitHub Actions pipelines for a generated repository (roadmap R8.3). Rendered from the
 * plan, never written by an agent: the YAML is validated by `validateWorkflow` before it is committed.
 */

export const CI_PATH = '.github/workflows/ci.yml';
export const RELEASE_PATH = '.github/workflows/release.yml';

const ACTIONS = {
  checkout: 'actions/checkout@v4',
  node: 'actions/setup-node@v4',
  python: 'actions/setup-python@v5',
  go: 'actions/setup-go@v5',
  rust: 'actions-rust-lang/setup-rust-toolchain@v1',
  gitleaks: 'gitleaks/gitleaks-action@v2',
  buildx: 'docker/setup-buildx-action@v3',
  login: 'docker/login-action@v3',
  meta: 'docker/metadata-action@v5',
  build: 'docker/build-push-action@v6',
} as const;

type Step = Record<string, unknown>;
const planStack = (plan: Plan): StackKind => stackKind(`${plan.stack} ${plan.gateImage}`);

// Docker image name and the setup action's own version key, per stack.
const SETUP: Record<Exclude<StackKind, 'other' | 'flutter'>, { image: string; key: string }> = {
  node: { image: 'node', key: 'node-version' },
  python: { image: 'python', key: 'python-version' },
  go: { image: 'golang', key: 'go-version' },
  rust: { image: 'rust', key: 'toolchain' },
};

/** `node:22-bookworm` -> `22`, `python:3.12-slim` -> `3.12`; undefined when the image carries no usable version (`rust:1-bookworm`). */
const toolVersion = (plan: Plan, image: string): string | undefined => new RegExp(`${image}:(\\d+(?:\\.\\d+)${image === 'rust' ? '' : '?'})`, 'i').exec(plan.gateImage)?.[1];

function setupStep(plan: Plan): Step[] {
  const kind = planStack(plan);
  // A Flutter CI needs its own setup action (Flutter and the Android SDK), which does not exist yet.
  if (kind === 'other' || kind === 'flutter') return [];
  const { image, key } = SETUP[kind];
  const version = toolVersion(plan, image);
  return [{ uses: ACTIONS[kind], ...(version ? { with: { [key]: version } } : {}) }];
}

export const COMPOSE_UP = 'docker compose up -d --build --wait';
export const COMPOSE_DOWN = 'docker compose down -v';

/** Commands a CI/release run step may use: every plan command and every plan gate command. */
export function allowedCommands(plan: Plan): Set<string> {
  const out = new Set<string>();
  for (const v of Object.values(plan.commands)) if (typeof v === 'string') out.add(v.trim());
  for (const g of plan.gates) out.add(g.command.trim());
  if (e2eCommand(plan)) { out.add(COMPOSE_UP); out.add(COMPOSE_DOWN); }
  return out;
}

const dump = (doc: unknown): string => stringify(doc, { lineWidth: 0 });

export function renderCi(plan: Plan): string {
  const c = plan.commands;
  const run = (name: string, command: string): Step => ({ name, run: command });
  const steps: Step[] = [
    { uses: ACTIONS.checkout, with: { 'fetch-depth': 0 } },
    ...setupStep(plan),
    run('Install', c.install),
    run('Format', c.format),
    run('Lint', c.lint),
    ...(c.typecheck ? [run('Typecheck', c.typecheck)] : []),
    run('Unit tests', c.test),
    run('Build', c.build),
    { name: 'Secret scan', uses: ACTIONS.gitleaks, env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' } },
  ];
  const e2e = e2eCommand(plan);
  const e2eJob = e2e ? {
    e2e: {
      needs: 'verify',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 30,
      steps: [
        { uses: ACTIONS.checkout },
        ...setupStep(plan),
        run('Install', c.install),
        run('Compose up', COMPOSE_UP),
        { name: 'E2E', run: e2e, env: { SERVICE_URL: `http://localhost:${plan.deploy.port}` } },
        { name: 'Compose down', if: 'always()', run: COMPOSE_DOWN },
      ],
    },
  } : {};
  return dump({
    name: 'ci',
    on: { push: { branches: ['main'] }, pull_request: {} },
    permissions: { contents: 'read' },
    concurrency: { group: 'ci-${{ github.ref }}', 'cancel-in-progress': true },
    jobs: { verify: { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 30, steps }, ...e2eJob },
  });
}

export function renderRelease(plan: Plan): string {
  const image = `ghcr.io/\${{ github.repository_owner }}/${plan.deploy.image}`;
  const steps: Step[] = [
    { uses: ACTIONS.checkout },
    { uses: ACTIONS.buildx },
    { name: 'Log in to ghcr.io', uses: ACTIONS.login, with: { registry: 'ghcr.io', username: '${{ github.actor }}', password: '${{ secrets.GITHUB_TOKEN }}' } },
    { id: 'meta', uses: ACTIONS.meta, with: { images: image, tags: 'type=sha,prefix=,format=long\ntype=raw,value=latest\n' } },
    { name: 'Build and push', uses: ACTIONS.build, with: { context: '.', push: true, tags: '${{ steps.meta.outputs.tags }}', labels: '${{ steps.meta.outputs.labels }}' } },
  ];
  return dump({
    name: 'release',
    on: { push: { branches: ['main'], tags: ['v*'] } },
    permissions: { contents: 'read' },
    jobs: { image: { 'runs-on': 'ubuntu-latest', permissions: { contents: 'read', packages: 'write' }, steps } },
  });
}

export function renderWorkflows(plan: Plan): Array<{ path: string; kind: 'ci' | 'release'; text: string }> {
  return [{ path: CI_PATH, kind: 'ci', text: renderCi(plan) }, { path: RELEASE_PATH, kind: 'release', text: renderRelease(plan) }];
}

interface Job { 'runs-on'?: unknown; steps?: unknown; permissions?: unknown }

/**
 * Pure structural check (actionlint is not available offline). Returns one message per problem; an empty
 * array means valid. Rules: parses, required keys, least-privilege permissions, actions pinned by major
 * tag, and every `run` step is a command from the plan.
 */
export function validateWorkflow(kind: 'ci' | 'release', text: string, plan: Plan): string[] {
  const errors: string[] = [];
  let doc: Record<string, unknown>;
  try {
    const parsed = parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ['workflow is not a YAML mapping'];
    doc = parsed as Record<string, unknown>;
  } catch (err) {
    return [`invalid YAML: ${(err as Error).message}`];
  }
  for (const key of ['name', 'on', 'permissions', 'jobs']) if (doc[key] === undefined) errors.push(`missing top-level key "${key}"`);
  if (doc.permissions === 'write-all') errors.push('permissions must not be write-all');
  const jobs = doc.jobs;
  if (typeof jobs !== 'object' || jobs === null || Object.keys(jobs).length === 0) return [...errors, 'jobs must be a non-empty mapping'];

  const allowed = allowedCommands(plan);
  const uses: string[] = [];
  const runs: string[] = [];
  for (const [id, raw] of Object.entries(jobs as Record<string, Job>)) {
    if (raw['runs-on'] === undefined) errors.push(`job ${id}: missing runs-on`);
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      errors.push(`job ${id}: steps must be a non-empty list`);
      continue;
    }
    const perms = raw.permissions;
    if (perms && typeof perms === 'object') {
      for (const [scope, level] of Object.entries(perms as Record<string, string>)) {
        if (level === 'write' && !(kind === 'release' && scope === 'packages')) errors.push(`job ${id}: permission ${scope}: write is not allowed`);
      }
    }
    for (const step of raw.steps as Step[]) {
      if (typeof step.uses === 'string') uses.push(step.uses);
      if (typeof step.run === 'string') runs.push(step.run.trim());
      if (step.uses === undefined && step.run === undefined) errors.push(`job ${id}: step without uses or run`);
    }
  }
  for (const u of uses) if (!/^[\w.-]+\/[\w./-]+@v\d+$/.test(u)) errors.push(`action ${u} must be pinned by major tag (owner/name@vN)`);
  for (const r of runs) if (!allowed.has(r)) errors.push(`run step "${r}" is not a command from the plan`);

  if (kind === 'ci') {
    if (!uses.some((u) => u.startsWith('actions/checkout@'))) errors.push('ci is missing actions/checkout');
    const c = plan.commands;
    const need: Array<[string | undefined, string]> = [[c.install, 'install'], [c.format, 'format'], [c.lint, 'lint'], [c.typecheck, 'typecheck'], [c.test, 'test'], [c.build, 'build']];
    for (const [cmd, label] of need) if (cmd !== undefined && !runs.includes(cmd.trim())) errors.push(`ci is missing the ${label} step (${cmd})`);
    if (!uses.some((u) => u.startsWith('gitleaks/'))) errors.push('ci is missing the secret scan step');
    const e2e = e2eCommand(plan);
    if (e2e) {
      for (const [cmd, label] of [[COMPOSE_UP, 'compose up'], [e2e, 'e2e'], [COMPOSE_DOWN, 'compose down']] as const) if (!runs.includes(cmd.trim())) errors.push(`ci is missing the ${label} step (${cmd})`);
      if (!text.includes('SERVICE_URL')) errors.push('ci e2e step must set SERVICE_URL');
    }
  } else {
    for (const prefix of ['actions/checkout@', 'docker/setup-buildx-action@', 'docker/login-action@', 'docker/build-push-action@']) {
      if (!uses.some((u) => u.startsWith(prefix))) errors.push(`release is missing ${prefix}vN`);
    }
    if (plan.deploy.image !== undefined && (!text.includes('ghcr.io') || !text.includes(plan.deploy.image))) errors.push(`release must push ghcr.io/<owner>/${plan.deploy.image}`);
    if (!text.includes('secrets.GITHUB_TOKEN')) errors.push('release must log in with GITHUB_TOKEN');
    if (!text.includes('type=sha') || !text.includes('type=raw,value=latest')) errors.push('release must tag the commit sha and latest');
  }
  return errors;
}
