import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgents } from './agents/registry.js';
import { loadConfig, type Config } from './config/config.js';
import { Project } from './contracts/project.js';
import { Spec } from './contracts/spec.js';
import { loadSecrets } from './core/secrets.js';
import { execCommand, type Exec } from './exec/command.js';
import { Graphify } from './knowledge/graphify.js';
import { KnowledgeIndex } from './knowledge/retrieval.js';
import { Run, type ExecuteResult, type RunDeps } from './orchestrator/run.js';
import { expandHome, stateFile, workspacePaths } from './orchestrator/workspace.js';
import { runStep } from './runner/step.js';
import { startApi } from './api/server.js';
import { onboardingRoutes } from './api/onboarding-routes.js';
import { defaultRunControl } from './api/run-control.js';
import { runRoutes } from './api/run-routes.js';
import { refineRoutes } from './api/refine-routes.js';
import { readProject, runsDir } from './api/run-index.js';
import { makeRunAgent } from './refine/agent.js';
import { SessionRegistry } from './refine/registry.js';
import { addProject, readUserConfig } from './onboarding/config-store.js';
import { hasScript, spawnScriptPty } from './onboarding/pty.js';
import { DockerLocalTarget } from './deploy/docker-local.js';
import { KindTarget } from './deploy/kind.js';
import { httpGet } from './deploy/target.js';

export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const USAGE = `Usage:
  teams-ai run    --project <dir> [--spec <id>] [--run-id <id>] [--max-parallel N] [--dry-run] [--draft]
  teams-ai resume --project <dir> --run <runId>
  teams-ai status --project <dir> --run <runId> [--json]
  teams-ai ui     [--port N]            start the local web UI (onboarding, status)`;

export interface UiHooks {
  startUi?: (port: number) => Promise<{ port: number; close(): Promise<void> }>;
  waitForSignal?: () => Promise<void>;
  /** Called with the stop callback; returns a function that removes the handlers. */
  signals?: (onStop: () => void) => () => void;
}

function realSignals(onStop: () => void): () => void {
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  return () => {
    process.off('SIGTERM', onStop);
    process.off('SIGINT', onStop);
  };
}

async function startUiReal(port: number, io: CliIo): Promise<{ port: number; close(): Promise<void> }> {
  if (!(await hasScript(io.env))) throw new Error('the web UI needs util-linux `script` on PATH (apt install bsdutils)');
  const cfg = loadConfig(await fs.readFile(path.join(expandHome('~/.teams-ai'), 'config.json'), 'utf8').then(JSON.parse).catch(() => ({})));
  const staticDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'web', 'dist');
  const hasDist = await fs.access(path.join(staticDir, 'index.html')).then(() => true, () => false);
  if (!hasDist) io.stderr('web/dist not found: run `npm run web:build` (or `npm run web:dev` for the Vite dev server with /api proxied)');
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  return startApi(
    {
      routes: [
        ...onboardingRoutes({ exec: execCommand, fetch: globalThis.fetch, hostEnv: io.env, secretsDir: expandHome(cfg.paths.secrets), spawn: spawnScriptPty, log: io.stderr }),
        ...runRoutes({ cfg: async () => (await readUserConfig()).cfg, control: defaultRunControl(repoRoot), log: io.stderr }),
        ...refineRoutes({
          registry: new SessionRegistry({
            cfg: async () => (await readUserConfig()).cfg,
            runAgent: await makeRunAgent({ cfg, agentsDir: path.join(repoRoot, '.claude', 'agents'), hostEnv: io.env, secretsDir: expandHome(cfg.paths.secrets), workspacesRoot: expandHome(cfg.paths.workspaces) }),
            secretsDir: expandHome(cfg.paths.secrets),
            exec: execCommand,
            projectDir: async (projectId) => {
              for (const { dir } of (await readUserConfig()).cfg.projects) {
                const read = await readProject(dir).catch(() => null);
                if (read?.project.projectId === projectId) return dir;
              }
              return null;
            },
            control: defaultRunControl(repoRoot),
            runsDir: async () => runsDir({ cfg: (await readUserConfig()).cfg, isAlive: () => false }),
            register: (dir) => addProject(dir).then(() => undefined),
          }),
          log: io.stderr,
        }),
      ],
      staticDir: hasDist ? staticDir : null,
      log: io.stderr,
    },
    port,
  );
}

function flags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

export function exitCode(result: ExecuteResult): number {
  if (result === 'complete' || result === 'awaiting-validation' || result === 'done') return 0;
  if (result === 'drained') return 3;
  return 2;
}

async function readJson<T>(file: string, parse: (v: unknown) => T): Promise<T> {
  return parse(JSON.parse(await fs.readFile(file, 'utf8')));
}

async function preconditions(exec: Exec, repo: string, specId: string, draft: boolean): Promise<string[]> {
  const errors: string[] = [];
  const check = async (label: string, spec: Parameters<Exec>[0], test?: (stdout: string) => boolean) => {
    const r = await exec(spec).catch(() => null);
    if (!r || r.exitCode !== 0 || (test && !test(r.stdout))) errors.push(label);
  };
  if (!draft) await check('repo/ is not a git clone with origin', { bin: 'git', args: ['-C', repo, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'], timeoutMs: 60_000 });
  if (!draft) await check('main lacks docs/project.json', { bin: 'git', args: ['-C', repo, 'cat-file', '-e', 'origin/main:docs/project.json'], timeoutMs: 10_000 });
  if (!draft) await check(`main lacks docs/specs/${specId}/spec.json`, { bin: 'git', args: ['-C', repo, 'cat-file', '-e', `origin/main:docs/specs/${specId}/spec.json`], timeoutMs: 10_000 });
  await check('claude is not logged in', { bin: 'claude', args: ['auth', 'status', '--json'], timeoutMs: 30_000 }, (out) => /"loggedIn":\s*true/.test(out));
  await check('gh is not logged in', { bin: 'gh', args: ['auth', 'status'], timeoutMs: 30_000 });
  await check('docker daemon is not reachable', { bin: 'docker', args: ['version'], timeoutMs: 30_000 });
  return errors;
}

export async function loadRunDeps(io: CliIo, projectDir: string, specIdArg: string | undefined, opts: { dryRun: boolean; maxParallel?: number; draft?: boolean }): Promise<RunDeps> {
  const cfgFile = path.join(expandHome('~/.teams-ai'), 'config.json');
  const cfg: Config = loadConfig(await fs.readFile(cfgFile, 'utf8').then(JSON.parse).catch(() => ({})));
  const project = await readJson(path.join(projectDir, 'docs', 'project.json'), (v) => Project.parse(v));
  const specId = specIdArg ?? (await fs.readdir(path.join(projectDir, 'docs', 'specs'))).sort().at(-1);
  if (!specId) throw new Error('no spec found under docs/specs and no --spec given');
  const spec = await readJson(path.join(projectDir, 'docs', 'specs', specId, 'spec.json'), (v) => Spec.parse(v));
  if (spec.status !== 'running' || !spec.specHash) throw new Error(`spec ${specId} is not frozen (status ${spec.status}); finish Gate 1 first`);
  const ws = workspacePaths(cfg, project.projectId);
  const secrets = await loadSecrets(expandHome(cfg.paths.secrets));
  // The orchestrator authenticates to GitHub as the token's user (spec §10 GITHUB_TOKEN), for `gh` and for
  // git over HTTPS alike; the interactive `gh auth login` may belong to a different account. The helper reads
  // the token from the environment, so it never appears on a command line or in a remote URL.
  const gitAuth: Record<string, string> = secrets.GITHUB_TOKEN
    ? {
        GH_TOKEN: secrets.GITHUB_TOKEN,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
      }
    : {};
  const exec: Exec = (s) => execCommand(s.bin === 'git' ? { ...s, env: { ...(s.env ?? {}), ...gitAuth } } : s);
  const ghExec: Exec = (s) => execCommand({ ...s, env: { ...(s.env ?? {}), ...gitAuth } });
  const errors = await preconditions(exec, ws.repo, specId, opts.draft === true);
  if (errors.length > 0) throw new Error(`preconditions failed:\n- ${errors.join('\n- ')}`);
  const agents = await loadAgents(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.claude', 'agents'));
  const graphify = new Graphify({ exec, readFile: (p) => fs.readFile(p, 'utf8').catch(() => null) });
  const knowledge = KnowledgeIndex.open(ws.knowledgeDb);
  const firstSpec = (await fs.readdir(path.join(projectDir, 'docs', 'specs'))).length === 1;
  let binary: RunDeps['binary'] = { bin: io.env.CLAUDE_BIN ?? 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' };
  let step = runStep;
  if (opts.dryRun) {
    const { Scenario } = await import('../test/fixtures/fake-claude/scenario.js');
    const scenario = new Scenario(path.join(os.tmpdir(), 'teams-ai-dry-run'));
    binary = { bin: process.execPath, prefixArgs: [path.resolve('test/fixtures/fake-claude/fake-claude.mjs')], env: {}, requireSandboxTools: false };
    step = scenario.wrap(runStep);
    io.stderr('dry run: every agent step answers from the fake claude scenario (set steps in code before use)');
  }
  const bootstrap = opts.draft ? { docsDir: path.join(projectDir, 'docs'), owner: project.github.owner ?? cfg.github.owner } : undefined;
  const target = project.deploy.target === 'kind'
    ? new KindTarget({ exec, secrets, cluster: 'teams-ai', readFile: (p) => fs.readFile(p, 'utf8') })
    : new DockerLocalTarget({ exec, get: httpGet, secrets });
  return { cfg, ws, project, spec, firstSpec, exec, ghExec, runStep: step, binary, agents, graphify, knowledge, secrets, log: io.stderr, maxParallel: opts.maxParallel, bootstrap, target };
}

type Factory = (deps: RunDeps, runId?: string, explicitId?: string) => Promise<Run>;
const defaultFactory: Factory = (deps, runId, explicitId) => (runId ? Run.resume(deps, runId) : Run.create(deps, explicitId));

/**
 * `factory` is the seam tests use to substitute the Run; with a custom factory the dependency
 * loading is best-effort (a missing project on disk yields `null` deps), since the factory owns them.
 */
export async function main(io: CliIo, factory: Factory = defaultFactory, hooks: UiHooks = {}): Promise<number> {
  const [command, ...rest] = io.argv;
  const f = flags(rest);
  const projectDir = typeof f.project === 'string' ? f.project : null;
  if (!command || !['run', 'resume', 'status', 'ui'].includes(command) || (!projectDir && command !== 'ui')) {
    io.stderr(USAGE);
    if (command && !projectDir) io.stderr('--project <dir> is required');
    return 2;
  }
  try {
    if (command === 'ui') {
      const port = typeof f.port === 'string' ? Number(f.port) : 8787;
      const server = await (hooks.startUi ?? ((p) => startUiReal(p, io)))(port);
      io.stderr(`Open http://localhost:${server.port}/`);
      await (hooks.waitForSignal ?? (() => new Promise<void>((resolve) => { process.once('SIGINT', () => resolve()); process.once('SIGTERM', () => resolve()); })))();
      await server.close();
      return 0;
    }
    if (!projectDir) return 2; // unreachable: the guard above admits a missing --project only for `ui`
    if (command === 'status') {
      const cfg = loadConfig({});
      const project = await readJson(path.join(projectDir, 'docs', 'project.json'), (v) => Project.parse(v));
      const file = stateFile(workspacePaths(cfg, project.projectId), String(f.run));
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as { status: string; tasks: Array<{ id: string; state: string; attempts: number }>; tokens: Record<string, number> };
      if (f.json) io.stdout(JSON.stringify(state, null, 2));
      else {
        io.stdout(`run ${String(f.run)}: ${state.status}`);
        for (const t of state.tasks) io.stdout(`  ${t.id.padEnd(16)} ${t.state.padEnd(13)} attempts=${t.attempts}`);
        io.stdout(`tokens: in=${state.tokens.inputTokens} out=${state.tokens.outputTokens} cost=$${state.tokens.costUsd}`);
      }
      return 0;
    }
    const load = loadRunDeps(io, projectDir, typeof f.spec === 'string' ? f.spec : undefined, { dryRun: f['dry-run'] === true, draft: f.draft === true, maxParallel: typeof f['max-parallel'] === 'string' ? Number(f['max-parallel']) : undefined });
    const deps = factory === defaultFactory ? await load : await load.catch(() => null as unknown as RunDeps);
    const explicitId = typeof f['run-id'] === 'string' ? f['run-id'] : undefined;
    if (explicitId !== undefined && !/^[A-Za-z0-9_.-]+$/.test(explicitId)) throw new Error('--run-id must match ^[A-Za-z0-9_.-]+$');
    const run = await factory(deps, command === 'resume' ? String(f.run) : undefined, explicitId);
    io.stderr(`run ${run.runId} started`);
    const off = (hooks.signals ?? realSignals)(() => {
      io.stderr('stop requested: draining');
      void run.requestStop();
    });
    let result: ExecuteResult;
    try {
      result = await run.execute();
    } finally {
      off();
      await run.close();
    }
    if (result === 'paused:auth') io.stderr('run paused: claude auth expired; run "claude auth login" and resume');
    else io.stderr(`run ${run.runId} finished: ${result}`);
    return exitCode(result);
  } catch (err) {
    io.stderr((err as Error).message);
    return 2;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main({ argv: process.argv.slice(2), env: process.env, stdout: (s) => process.stdout.write(`${s}\n`), stderr: (s) => process.stderr.write(`${s}\n`) }).then((code) => process.exit(code));
}
