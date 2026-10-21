import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgents } from './agents/registry.js';
import { loadConfig, type Config } from './config/config.js';
import { Project } from './contracts/project.js';
import { generatedSecretNames, Spec } from './contracts/spec.js';
import { writeFileAtomic } from './core/atomic-write.js';
import { redactSecrets } from './core/redact.js';
import { ensureGeneratedSecrets, loadSecrets } from './core/secrets.js';
import { execCommand, type Exec } from './exec/command.js';
import { gitAuthEnv, withGitAuth } from './git/auth.js';
import { Graphify } from './knowledge/graphify.js';
import { mergeProjectGraph } from './knowledge/project-graph.js';
import { openProjectKnowledge } from './knowledge/project-docs.js';
import { isFirstSpec } from './orchestrator/first-spec.js';
import { Run, type ExecuteResult, type RunDeps } from './orchestrator/run.js';
import { expandHome, firstSpecForRun, firstSpecForSpec, nextRunId, specForRun, stateFile, workspacePaths } from './orchestrator/workspace.js';
import { runStep } from './runner/step.js';
import { startApi } from './api/server.js';
import { licenseGuard } from './api/license-guard.js';
import { licenseRoutes } from './api/license-routes.js';
import { onboardingRoutes } from './api/onboarding-routes.js';
import { settingsRoutes } from './api/settings-routes.js';
import { defaultRunControl, isAlive, type RunControlDeps } from './api/run-control.js';
import { opsRoutes } from './api/ops-routes.js';
import { runRoutes } from './api/run-routes.js';
import { refineRoutes } from './api/refine-routes.js';
import { chatRoutes } from './api/chat-routes.js';
import { ChatService } from './chat/service.js';
import { ChatStore } from './chat/store.js';
import { readProject, runsDir, type IndexDeps } from './api/run-index.js';
import { supervise } from './supervisor/supervise.js';
import { makeRunAgent } from './refine/agent.js';
import { SessionRegistry } from './refine/registry.js';
import { createJevValidator } from './refine/jev-validation.js';
import { createJevScorer } from './refine/jev-scoring.js';
import { createDecider } from './decide/create-decider.js';
import type { DecisionOutcome } from './decide/types.js';
import { routeReport } from './decide/decisions/report-routing.js';
import { Accounting } from './budget/accounting.js';
import { addProject, readUserConfig } from './onboarding/config-store.js';
import { hasScript, spawnScriptPty } from './onboarding/pty.js';
import { DATASTORE_CREDENTIALS, datastoreCredentialsOf } from './deploy/datastore-credentials.js';
import { DockerLocalTarget } from './deploy/docker-local.js';
import { httpGet } from './deploy/target.js';
import { readRepairNotes } from './program/repair-notes.js';
import { ensureAgentPlugins } from './skills/plugins.js';
import { clearPrivateSkills, ensurePinnedSkills } from './skills/store.js';

export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const USAGE = `Usage:
  teams-ai run    --project <dir> [--spec <id>] [--run-id <id>] [--max-parallel N] [--dry-run] [--draft]
  teams-ai resume --project <dir> --run <runId>
  teams-ai spec readme --project <dir> --spec <id> [--run-id <id>]   the SM writes docs/README.md (docs PR)
  teams-ai spec deploy --project <dir> --spec <id> [--target docker-local] [--run-id <id>]   deploy main again, no agent
  teams-ai status --project <dir> --run <runId> [--json]
  teams-ai supervise --project <dir> [--interval s]   resume interrupted runs until they finish
  teams-ai ui     [--port N]            start the local web UI (onboarding, status)`;

export interface UiHooks {
  startUi?: (port: number) => Promise<{ port: number; close(): Promise<void> }>;
  waitForSignal?: () => Promise<void>;
  /** Called with the stop callback; returns a function that removes the handlers. */
  signals?: (onStop: () => void) => () => void;
  /** Replaces the real run index and process control of `supervise`. */
  supervision?: { idx: IndexDeps; control: RunControlDeps };
}

/** How often the program controller looks at every started backlog (a delivered spec is noticed within this). */
const PROGRAM_TICK_MS = 15_000;

/** A decider that threw answers nothing, with its redacted reason, instead of passing for an exhausted one. */
export const failedDecision = (err: unknown): DecisionOutcome => ({ answered: false, reason: 'error', message: redactSecrets(err instanceof Error ? err.message : String(err)) });

function realSignals(onStop: () => void): () => void {
  process.on('SIGTERM', onStop);
  process.on('SIGINT', onStop);
  return () => {
    process.off('SIGTERM', onStop);
    process.off('SIGINT', onStop);
  };
}

/** Fetches the pinned skills and builds the role plugins; a failure is reported and the run goes on without them. */
async function prepareSkills(exec: Exec, env: NodeJS.ProcessEnv, stderr: (line: string) => void): Promise<void> {
  const root = expandHome('~/.teams-ai/skills');
  await ensurePinnedSkills(root, exec, env).catch((error: Error) => stderr(`pinned skills unavailable, continuing without them: ${error.message}`));
  await ensureAgentPlugins(root, env).catch((error: Error) => stderr(`agent plugins unavailable, continuing without them: ${error.message}`));
}

async function startUiReal(port: number, io: CliIo): Promise<{ port: number; close(): Promise<void> }> {
  if (!(await hasScript(io.env))) throw new Error('the web UI needs util-linux `script` on PATH (apt install bsdutils)');
  const cfg = loadConfig(await fs.readFile(path.join(expandHome('~/.teams-ai'), 'config.json'), 'utf8').then(JSON.parse).catch(() => ({})));
  const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  const hasDist = await fs.access(path.join(staticDir, 'index.html')).then(() => true, () => false);
  if (!hasDist) io.stderr('web/dist not found: run `npm run web:build` (or `npm run web:dev` for the Vite dev server with /api proxied)');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await prepareSkills(execCommand, io.env, (line) => io.stderr(line));
  // Decisions asked by the UI server (report routing, Gate 1) chain jev → local only: there is no claude step to escalate to.
  const uiDecider = async () => createDecider({
    cfg: (await readUserConfig()).cfg,
    secrets: await loadSecrets(expandHome(cfg.paths.secrets)),
    accounting: new Accounting(),
    runEscalation: async () => { throw new Error('UI-server decisions do not escalate to Claude'); },
  });
  // One agent runner for refinement and chat, so both share the governor, the quota breaker and the ledger.
  const runAgent = await makeRunAgent({ cfg, agentsDir: path.join(repoRoot, '.claude', 'agents'), hostEnv: io.env, secretsDir: expandHome(cfg.paths.secrets), workspacesRoot: expandHome(cfg.paths.workspaces), agentSettings: async (projectId) => (await readUserConfig()).cfg.agentSettings[projectId] ?? {} });
  const projectDirOf = async (projectId: string): Promise<string | null> => {
    for (const { dir } of (await readUserConfig()).cfg.projects) {
      const read = await readProject(dir).catch(() => null);
      if (read?.project.projectId === projectId) return dir;
    }
    return null;
  };
  const graphify = new Graphify({ exec: execCommand, readFile: (p) => fs.readFile(p, 'utf8').catch(() => null) });
  const registry = new SessionRegistry({
    cfg: async () => (await readUserConfig()).cfg,
    runAgent,
    validateDocs: createJevValidator(cfg, async () => loadSecrets(expandHome(cfg.paths.secrets))),
    scoreDocs: createJevScorer(cfg, async () => loadSecrets(expandHome(cfg.paths.secrets))),
    secretsDir: expandHome(cfg.paths.secrets),
    exec: withGitAuth(execCommand, expandHome(cfg.paths.secrets)),
    projectDir: projectDirOf,
    control: defaultRunControl(repoRoot),
    runsDir: async () => runsDir({ cfg: (await readUserConfig()).cfg, isAlive: () => false }),
    register: (dir) => addProject(dir).then(() => undefined),
    routeReport: async (criteria, report, confidential) =>
      // The route is only a hint for PO and SM; a broken System 1 must not block reopening the spec.
      routeReport(criteria, report, await uiDecider(), { confidential }).catch(() => null),
    // Gate 1 filters only route and drop; a broken System 1 must not fail a refinement cycle.
    decider: { decide: (...args) => uiDecider().then((d) => d.decide(...args)).catch(failedDecision) },
  });
  // R11.4: the program ledgers of started backlogs are reconciled here, so a restart of the container picks every one up again.
  // A rejected tick would be an unhandled rejection, which ends the process.
  const tick = () => registry.tickPrograms().catch((err) => io.stderr(`programs tick: ${err instanceof Error ? err.message : String(err)}`));
  const programTimer = setInterval(tick, PROGRAM_TICK_MS);
  programTimer.unref();
  setTimeout(tick, 5_000).unref();
  const chat = new ChatService({
    guideDir: path.join(repoRoot, 'docs', 'guia'),
    store: new ChatStore(path.join(expandHome('~/.teams-ai'), 'chats')),
    index: async () => ({ cfg: (await readUserConfig()).cfg, isAlive: (pid) => isAlive(defaultRunControl(repoRoot), pid) }),
    runAgent,
    log: io.stderr,
    workspacesRoot: async () => expandHome((await readUserConfig()).cfg.paths.workspaces),
    suggestSpecId: async (projectId, description) => (await registry.suggestName('spec', { projectId, name: '', description })).id,
    newSpec: (projectId, specId, description) => registry.newSpec(projectId, specId, description),
    refreshProjectGraph: async (projectId) => {
      const dir = await projectDirOf(projectId);
      const read = dir ? await readProject(dir) : null;
      if (!read) throw new Error('project not found');
      await mergeProjectGraph(graphify, workspacePaths((await readUserConfig()).cfg, projectId), read.project, read.project.services ?? []);
    },
  });
  const guard = await licenseGuard();
  const api = await startApi(
    {
      guard,
      routes: [
        ...licenseRoutes({ serviceUrl: process.env.LICENSE_SERVICE_URL ?? '', onChange: guard.reload }),
        ...onboardingRoutes({ exec: execCommand, fetch: globalThis.fetch, hostEnv: io.env, secretsDir: expandHome(cfg.paths.secrets), spawn: spawnScriptPty, log: io.stderr, onClaudeLogin: () => runAgent.resetQuota() }),
        ...runRoutes({ cfg: async () => (await readUserConfig()).cfg, control: defaultRunControl(repoRoot), log: io.stderr, queueInProgram: (p, s) => registry.queueInProgram(p, s), importBacklog: (projectId) => registry.startImportedBacklog(projectId), graphify, clearChat: (projectId) => chat.clear(projectId) }),
        ...opsRoutes({ index: async () => ({ cfg: (await readUserConfig()).cfg, isAlive: (pid) => isAlive(defaultRunControl(repoRoot), pid) }) }),
        ...refineRoutes({
          registry,
          log: io.stderr,
        }),
        ...chatRoutes({ chat }),
        ...settingsRoutes({}),
      ],
      staticDir: hasDist ? staticDir : null,
      log: io.stderr,
    },
    port,
  );
  return { port: api.port, close: async () => { clearInterval(programTimer); await api.close(); } };
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

/** The run sets `awaiting-validation` on main only; a separate project dir (the draft root the UI reads) keeps the frozen `running`. */
export async function markAwaitingValidation(projectDir: string, specId: string, repo: string): Promise<void> {
  if (path.resolve(projectDir) === path.resolve(repo)) return;
  const file = path.join(projectDir, 'docs', 'specs', specId, 'spec.json');
  const spec = await readJson(file, (v) => Spec.parse(v));
  if (spec.status === 'running') await writeFileAtomic(file, `${JSON.stringify({ ...spec, status: 'awaiting-validation' }, null, 2)}
`);
}

/** A draft root whose spec main lacks (Phase 0 stopped before publishing it) publishes it first, also when started again. */
export async function startsAsDraft(exec: Exec, projectDir: string, ws: { root: string; repo: string }, specId: string): Promise<boolean> {
  if (!path.resolve(projectDir).startsWith(path.resolve(ws.root, 'refine') + path.sep)) return false;
  const r = await exec({ bin: 'git', args: ['-C', ws.repo, 'cat-file', '-e', `origin/main:docs/specs/${specId}/spec.json`], timeoutMs: 10_000 }).catch(() => null);
  return r?.exitCode !== 0;
}

async function readJson<T>(file: string, parse: (v: unknown) => T): Promise<T> {
  return parse(JSON.parse(await fs.readFile(file, 'utf8')));
}

async function preconditions(exec: Exec, repo: string, specId: string, draft: boolean, complete = false, readme = false, deploy = false): Promise<string[]> {
  const errors: string[] = [];
  const check = async (label: string, spec: Parameters<Exec>[0], test?: (stdout: string) => boolean) => {
    const r = await exec(spec).catch(() => null);
    if (!r || r.exitCode !== 0 || (test && !test(r.stdout))) errors.push(label);
  };
  if (!draft) await check('repo/ is not a git clone with origin', { bin: 'git', args: ['-C', repo, 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'], timeoutMs: 60_000 });
  if (!draft) await check('main lacks docs/project.json', { bin: 'git', args: ['-C', repo, 'cat-file', '-e', 'origin/main:docs/project.json'], timeoutMs: 10_000 });
  if (!draft) await check(`main lacks docs/specs/${specId}/spec.json`, { bin: 'git', args: ['-C', repo, 'cat-file', '-e', `origin/main:docs/specs/${specId}/spec.json`], timeoutMs: 10_000 });
  if (deploy) await check('docker daemon is not reachable', { bin: 'docker', args: ['version'], timeoutMs: 30_000 });
  if (!complete && !deploy) {
    await check('claude is not logged in', { bin: 'claude', args: ['auth', 'status', '--json'], timeoutMs: 30_000 }, (out) => /"loggedIn":\s*true/.test(out));
    await check('gh is not logged in', { bin: 'gh', args: ['auth', 'status'], timeoutMs: 30_000 });
    if (!readme) await check('docker daemon is not reachable', { bin: 'docker', args: ['version'], timeoutMs: 30_000 });
  }
  return errors;
}

/** Which spec a command works on: `--spec`, else the spec of the run being resumed, else the last spec directory. */
export const chooseSpecId = (explicit: string | undefined, fromRun: string | null, dirs: readonly string[]): string | undefined => explicit ?? fromRun ?? [...dirs].sort().at(-1);

export async function loadRunDeps(io: CliIo, projectDir: string, specIdArg: string | undefined, opts: { dryRun: boolean; maxParallel?: number; resumeRun?: string; draft?: boolean; complete?: boolean; readme?: boolean; deploy?: boolean; target?: 'docker-local' }): Promise<RunDeps> {
  const cfgFile = path.join(expandHome('~/.teams-ai'), 'config.json');
  const cfg: Config = loadConfig(await fs.readFile(cfgFile, 'utf8').then(JSON.parse).catch(() => ({})));
  const project = await readJson(path.join(projectDir, 'docs', 'project.json'), (v) => Project.parse(v));
  const ws = workspacePaths(cfg, project.projectId);
  const fromRun = opts.resumeRun ? await specForRun(ws, opts.resumeRun) : null;
  const specId = chooseSpecId(specIdArg, fromRun, await fs.readdir(path.join(projectDir, 'docs', 'specs')));
  if (!specId) throw new Error('no spec found under docs/specs and no --spec given');
  const spec = await readJson(path.join(projectDir, 'docs', 'specs', specId, 'spec.json'), (v) => Spec.parse(v));
  // A README is written for any spec whose code is on main, whatever its lifecycle status.
  // A deploy needs the spec's code on main: delivered (awaiting validation) or done.
  const allowed = opts.readme ? spec.status !== 'refining' : opts.deploy ? spec.status === 'awaiting-validation' || spec.status === 'done' : opts.complete ? spec.status === 'awaiting-validation' : spec.status === 'running';
  if (!allowed || !spec.specHash) throw new Error(`spec ${specId} is not ${opts.readme ? 'past refinement' : opts.deploy ? 'delivered (awaiting-validation or done)' : opts.complete ? 'awaiting-validation' : 'running'} (status ${spec.status}); finish Gate 1 first`);
  const platformSecrets = await loadSecrets(expandHome(cfg.paths.secrets));
  await ensureGeneratedSecrets(path.posix.join(ws.root, 'secrets'), [...generatedSecretNames(spec.externalDependencies), ...DATASTORE_CREDENTIALS, ...cfg.environment.generatedSecrets], platformSecrets);
  const secrets = { ...platformSecrets, ...(await loadSecrets(path.posix.join(ws.root, 'secrets'))) };
  const gitAuth = gitAuthEnv(platformSecrets.GITHUB_TOKEN);
  const exec: Exec = (s) => execCommand(s.bin === 'git' ? { ...s, env: { ...(s.env ?? {}), ...gitAuth } } : s);
  const ghExec: Exec = (s) => execCommand({ ...s, env: { ...(s.env ?? {}), ...gitAuth } });
  if (!opts.dryRun) await prepareSkills(exec, io.env, (line) => io.stderr(line));
  const draft = opts.draft === true || (!opts.complete && !opts.readme && !opts.deploy && (await startsAsDraft(exec, projectDir, ws, specId)));
  const errors = await preconditions(exec, ws.repo, specId, draft, opts.complete === true, opts.readme === true, opts.deploy === true);
  if (errors.length > 0) throw new Error(`preconditions failed:\n- ${errors.join('\n- ')}`);
  const agents = await loadAgents(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'agents'));
  const graphify = new Graphify({ exec, readFile: (p) => fs.readFile(p, 'utf8').catch(() => null) });
  // A `--draft` first run's workspace root (ws.root, parent of knowledgeDb) doesn't exist yet — Phase 0
  // creates ws.repo underneath it — so ensure it exists before SQLite tries to open a file inside it.
  await fs.mkdir(ws.root, { recursive: true });
  const knowledge = await openProjectKnowledge(ws.knowledgeDb, projectDir);
  // A retry (a fresh run-id, not --run) has no resume answer of its own, but an earlier run of this exact spec in
  // this project may have one; `specId` is never a valid run-id suffix, so it excludes nothing from that scan.
  const recordedFirst = opts.resumeRun ? await firstSpecForRun(ws, opts.resumeRun) : await firstSpecForSpec(ws, specId, specId);
  const firstSpec = recordedFirst ?? await isFirstSpec({ specDirs: await fs.readdir(path.join(projectDir, 'docs', 'specs')), specId, repo: ws.repo, exec });
  let binary: RunDeps['binary'] = { bin: io.env.CLAUDE_BIN ?? 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' };
  let step = runStep;
  if (opts.dryRun) {
    const { Scenario } = await import('../test/fixtures/fake-claude/scenario.js');
    const scenario = new Scenario(path.join(os.tmpdir(), 'teams-ai-dry-run'));
    binary = { bin: process.execPath, prefixArgs: [path.resolve('test/fixtures/fake-claude/fake-claude.mjs')], env: {}, requireSandboxTools: false };
    step = scenario.wrap(runStep);
    io.stderr('dry run: every agent step answers from the fake claude scenario (set steps in code before use)');
  }
  const bootstrap = draft ? { docsDir: path.join(projectDir, 'docs'), owner: project.github.owner ?? cfg.github.owner } : undefined;
  const target = new DockerLocalTarget({ exec, get: httpGet, secrets, generated: datastoreCredentialsOf(secrets, cfg.environment.generatedSecrets), serviceHost: cfg.docker.serviceHost, publishBind: cfg.docker.publishBind });
  return { cfg, ws, project, spec, repairNotes: await readRepairNotes(projectDir, specId), firstSpec, requireDelivery: true, requireSecurityTooling: true, requireE2e: true, requireCoverage: true, requireFrozenScope: true, exec, ghExec, runStep: step, binary, agents, graphify, knowledge, secrets, log: io.stderr, maxParallel: opts.maxParallel, bootstrap, target, agentSettings: async (projectId) => (await readUserConfig()).cfg.agentSettings[projectId] ?? {} };
}

type Factory = (deps: RunDeps, runId?: string, explicitId?: string) => Promise<Run>;
const defaultFactory: Factory = async (deps, runId, explicitId) => {
  if (runId) return Run.resume(deps, runId);
  // A new implementation run starts without the private drafts of earlier runs; deploy, complete and readme runs keep them.
  await clearPrivateSkills(expandHome('~/.teams-ai/skills'), deps.project.projectId);
  return Run.create(deps, explicitId);
};

/**
 * `factory` is the seam tests use to substitute the Run; with a custom factory the dependency
 * loading is best-effort (a missing project on disk yields `null` deps), since the factory owns them.
 */
export async function main(io: CliIo, factory: Factory = defaultFactory, hooks: UiHooks = {}): Promise<number> {
  const [command, ...rest] = io.argv;
  const f = flags(rest);
  const projectDir = typeof f.project === 'string' ? f.project : null;
  const completing = command === 'spec' && rest[0] === 'complete';
  const readming = command === 'spec' && rest[0] === 'readme';
  const deploying = command === 'spec' && rest[0] === 'deploy';
  const targetFlag = f.target;
  if (deploying && targetFlag !== undefined && targetFlag !== 'docker-local') {
    io.stderr(USAGE);
    io.stderr('--target must be docker-local');
    return 2;
  }
  if (!command || (!(completing || readming || deploying || ['run', 'resume', 'status', 'ui', 'supervise'].includes(command))) || (!projectDir && command !== 'ui')) {
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
    if (command === 'supervise') {
      const control = hooks.supervision?.control ?? defaultRunControl(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
      const idx = hooks.supervision?.idx ?? { cfg: (await readUserConfig()).cfg, isAlive: (pid: number) => control.kill(pid, 0) };
      const seconds = typeof f.interval === 'string' ? Number(f.interval) : 60;
      if (!(seconds > 0)) throw new Error('--interval must be a positive number of seconds');
      let stop = false;
      const off = (hooks.signals ?? realSignals)(() => {
        stop = true;
      });
      try {
        await supervise({ idx, control, projectDir: path.resolve(projectDir), intervalMs: seconds * 1000, now: Date.now, log: io.stderr }, () => stop, control.sleep);
      } finally {
        off();
      }
      return 0;
    }
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
    const load = loadRunDeps(io, projectDir, typeof f.spec === 'string' ? f.spec : undefined, { dryRun: f['dry-run'] === true, resumeRun: command === 'resume' ? String(f.run) : undefined, draft: f.draft === true, maxParallel: typeof f['max-parallel'] === 'string' ? Number(f['max-parallel']) : undefined, complete: completing, readme: readming, deploy: deploying, target: deploying ? (targetFlag as 'docker-local' | undefined) : undefined });
    const deps = factory === defaultFactory ? await load : await load.catch(() => null as unknown as RunDeps);
    const explicitId = typeof f['run-id'] === 'string' ? f['run-id'] : undefined;
    if (explicitId !== undefined && !/^[A-Za-z0-9_.-]+$/.test(explicitId)) throw new Error('--run-id must match ^[A-Za-z0-9_.-]+$');
    const run = completing || readming || deploying
      ? await Run.create(deps, explicitId ?? await nextRunId(deps.ws, deps.spec.specId, completing ? 'complete' : readming ? 'readme' : 'deploy'))
      : await factory(deps, command === 'resume' ? String(f.run) : undefined, explicitId);
    if (command === 'resume' && f['retry-blocked'] === true) await run.retryBlocked();
    io.stderr(`run ${run.runId} started`);
    const off = (hooks.signals ?? realSignals)(() => {
      io.stderr('stop requested: draining');
      void run.requestStop();
    });
    let result: ExecuteResult;
    try {
      result = completing ? await run.completeSpec() : readming ? await run.writeReadme() : deploying ? await run.deployOnly() : await run.execute();
    } finally {
      off();
      await run.close();
    }
    if (result === 'awaiting-validation' && deps) await markAwaitingValidation(projectDir, deps.spec.specId, deps.ws.repo);
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
