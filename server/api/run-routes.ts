import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { StepKind } from '../agents/outputs.js';
import { Accounting } from '../budget/accounting.js';
import { agentsDecideFor, type Config, type Role } from '../config/config.js';
import { AnyPlan } from '../contracts/plan.js';
import { loadSecretValues } from '../core/secrets.js';
import { redactSecrets } from '../core/redact.js';
import { removeTree } from '../core/remove-tree.js';
import { addProject, removeProjectDirs, removeProjectSettings } from '../onboarding/config-store.js';
import { repoName } from '../core/ids.js';
import type { Graphify } from '../knowledge/graphify.js';
import { buildProjectGraph } from '../knowledge/project-graph.js';
import { gateCacheDir } from '../orchestrator/run.js';
import { expandHome, serviceWorkspace, workspacePaths } from '../orchestrator/workspace.js';
import { OrchEvent } from '../orchestrator/events.js';
import { pairDecisions, readOwnerDecisions, recordOwnerDecisions } from '../orchestrator/owner-decisions.js';
import { execCommand, type Exec } from '../exec/command.js';
import { nextRunId } from '../orchestrator/workspace.js';
import { reduceEvents } from '../pipeline/run-state.js';
import { locateTests, testsByRepo, type TestRef } from '../evidence/locate.js';
import { EventLogCorruptError, loadEvents, type StoredEvent } from '../store/event-store.js';
import { httpGet, type HttpGet } from '../deploy/target.js';
import { teardownProject } from '../deploy/docker-local.js';
import { releaseDeployPort } from '../deploy/port-registry.js';
import { withGitAuth } from '../git/auth.js';
import { fetch as fetchRepo, git as runGit, showFile } from '../git/git.js';
import { BACKLOG_DOCS } from '../contracts/backlog.js';
import { refuseCloneHost, type ResolveHost } from './security.js';
import { tailJournal } from './journal-tail.js';
import { abandonLaunch, isAlive, spawnRun, stop, type RunControlDeps } from './run-control.js';
import { claimLaunch, claimsSpec, concludedSpecs, clearPid, clearStopRequested, finishOf, listProjects, listRuns, markStopRequested, readPid, readProject, runLiveness, runRow, runsDir, SAFE_ID, writePid, type IndexDeps, type ProjectRow, type RunRow } from './run-index.js';
import type { Spec } from '../contracts/spec.js';
import { HttpError, type Route } from './server.js';
import type { Report } from '../orchestrator/phases/report.js';
import { z } from 'zod';

export interface RunRoutesDeps {
  cfg: () => Promise<Config>;
  home?: string;
  control: RunControlDeps;
  log?: (line: string) => void;
  cloneProject?: (url: string, destination: string) => Promise<void>;
  /** Builds the project's code graph after an import; without it the import only clones. */
  graphify?: Graphify;
  /** Erases the project's chat history, which lives outside its workspace. */
  clearChat?: (projectId: string) => Promise<void>;
  /** Name resolution for the clone-host check; defaults to the system resolver. */
  resolveHost?: ResolveHost;
  /** Probe of the deployed service for the validation page; the real one is fetch with a timeout. */
  httpGet?: HttpGet;
  /** Runs the docker commands that take a deleted project's deploys down; the real one by default. */
  exec?: Exec;
  /** Prioritizes the spec in the started backlog program that still has it pending; null when no program owns it. */
  queueInProgram?: (projectId: string, specId: string) => Promise<{ draftId: string } | { refused: string } | null>;
  /** Starts the backlog of a project imported from git; the import answers without waiting for it. */
  importBacklog?: (projectId: string) => Promise<void>;
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>)[field] !== 'string') throw new HttpError(400, `${field} must be a string`);
  return (v as Record<string, string>)[field]!;
};

/** Address of a sibling repository of the same owner, e.g. the service repo next to the project's docs repo. */
export function siblingRepoUrl(remote: string, name: string): string {
  const url = new URL(remote);
  url.pathname = path.posix.join(path.posix.dirname(url.pathname), `${name}.git`);
  return url.toString();
}

/** Browsable https URL of a GitHub remote (https or ssh form), or null for any other host. */
export function githubRepoUrl(remote: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** Permalink to one line of a file at a commit of a GitHub repository; null when a part does not look right. */
export function blobUrl(repoUrl: string, commit: string, file: string, line: number): string | null {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repoUrl) || !/^[0-9a-f]{40,64}$/.test(commit) || !Number.isInteger(line) || line < 1) return null;
  return `${repoUrl}/blob/${commit}/${file.split('/').map(encodeURIComponent).join('/')}#L${line}`;
}

const originOf = (dir: string): Promise<string | null> =>
  execCommand({ bin: 'git', args: ['remote', 'get-url', 'origin'], cwd: dir, timeoutMs: 5_000 }).then((r) => (r.exitCode === 0 ? r.stdout.trim() : null), () => null);

/** GitHub page of the clone at repoDir, or null when it has no GitHub origin. */
async function repoUrlOf(repoDir: string): Promise<string | null> {
  const remote = await execCommand({ bin: 'git', args: ['remote', 'get-url', 'origin'], cwd: repoDir, timeoutMs: 5_000 }).catch(() => null);
  return remote?.exitCode === 0 ? githubRepoUrl(remote.stdout) : null;
}

/** The paths among `paths` that origin/main has; a git failure is raised, never read as a missing file. */
async function mainPaths(repo: string, paths: string[]): Promise<Set<string>> {
  const listed = await runGit(repo, ['ls-tree', '--name-only', 'origin/main', ...paths]);
  return new Set(listed.split('\n').filter(Boolean));
}

/** Where a project document sits on main: the briefing at the root, else the newest spec's when only that one exists. */
function docPath(file: string, present: ReadonlySet<string>, specBriefing: string | null): string {
  if (file !== 'briefing.md' || present.has('docs/briefing.md') || specBriefing === null || !present.has(specBriefing)) return `docs/${file}`;
  return specBriefing;
}

/** More tests than this in one repository are not located: the search grows with each of them. */
const MAX_LOCATED_TESTS = 500;

/** The GitHub links of the tests of one repository; a repository that fails gives none, and the log says why. */
async function testLinksIn(repoDir: string, tests: TestRef[], log?: (line: string) => void): Promise<Array<[string, { url: string; path: string; line: number }]>> {
  const repoUrl = await repoUrlOf(repoDir);
  if (repoUrl === null) return [];
  if (tests.length > MAX_LOCATED_TESTS) log?.(`test links: only the first ${MAX_LOCATED_TESTS} of ${tests.length} tests of ${repoDir} are located`);
  const found = await locateTests(repoDir, tests.slice(0, MAX_LOCATED_TESTS)).catch((err: Error) => {
    log?.(`test links skipped in ${repoDir}: ${err.message}`);
    return null;
  });
  if (found === null) return [];
  const links: Array<[string, { url: string; path: string; line: number }]> = [];
  for (const [id, place] of found.places) {
    const url = blobUrl(repoUrl, found.sha, place.path, place.line);
    if (url !== null) links.push([id, { url, path: place.path, line: place.line }]);
  }
  return links;
}

/** What went wrong in a failed clone and how to fix it, in the owner's words. */
export function cloneFailure(stderr: string): string {
  if (/could not read Username|Authentication failed|Repository not found|403|404/i.test(stderr)) {
    return 'não foi possível clonar o repositório: ele é privado ou não existe. Salve em Onboarding um GITHUB_TOKEN com permissão de leitura nele e confira a URL.';
  }
  if (/Could not resolve host|unable to access|timed out/i.test(stderr)) return 'não foi possível clonar o repositório: sem conexão com o servidor Git. Tente de novo.';
  return 'não foi possível clonar o repositório';
}

/** Puts the address this run deployed on into a report merged from main, whose own deploy may have used another port. */
/** A doc section the user accepted as out of scope; kept beside the run, so the report stays as the agents wrote it. */
export interface GapDecision { doc: string; heading: string; note: string; at: string }
const AcceptGap = z.object({ doc: z.string().min(1), heading: z.string().min(1), note: z.string().trim().min(1).max(500) });
/** The run's accepted sections; none when it accepted none. */
export async function readGapDecisions(runs: string, runId: string): Promise<GapDecision[]> {
  return fs.readFile(path.join(runs, runId, 'gap-decisions.json'), 'utf8').then((t) => JSON.parse(t) as GapDecision[]).catch(() => []);
}

export function withDeployedAddress(report: unknown, deployed: Record<string, unknown>): unknown {
  if (typeof report !== 'object' || report === null) return report;
  const r = report as { service?: object | null; services?: Array<{ service: string }> };
  const cards = Array.isArray(deployed.services) ? (deployed.services as Array<{ service: string; url: string; port?: number }>) : [];
  return {
    ...r,
    ...(r.service ? { service: { ...r.service, url: deployed.url, port: deployed.port } } : {}),
    ...(r.services ? { services: r.services.map((x) => { const c = cards.find((k) => k.service === x.service); return c ? { ...x, url: c.url, port: c.port } : x; }) } : {}),
  };
}

/** `{decisions: [{taskId, answer}]}` from the run screen: every answer a text of 1 to 2000 characters. */
const answersOf = (input: unknown): Array<{ taskId: string; answer: string }> => {
  const list = (input as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'decisions must be a list of answers');
  return list.map((item: unknown) => {
    const { taskId, answer } = (item ?? {}) as { taskId?: unknown; answer?: unknown };
    if (typeof taskId !== 'string' || typeof answer !== 'string' || answer.trim() === '' || answer.length > 2000) {
      throw new HttpError(400, 'each answer needs a taskId and a text of 1 to 2000 characters');
    }
    return { taskId, answer: answer.trim() };
  });
};

/** The questions a run asked the owner, each with the answer the owner gave it, if any. */
async function decisionsOf(evs: readonly StoredEvent[], runId: string, root: string | null, specId: string) {
  const answers = root ? await readOwnerDecisions(root, specId) : [];
  const asked = evs.filter((e) => e.type === OrchEvent.DecisionRequested).map((e) => ({ taskId: String(e.data.taskId), runId, question: String(e.data.question), options: e.data.options }));
  // The screen keeps the shape it always had: the run is implied by the page.
  return pairDecisions(asked, answers).map((d) => ({ taskId: d.taskId, question: d.question, options: d.options, answer: d.answer }));
}

export function runRoutes(deps: RunRoutesDeps): Route[] {
  const index = async (): Promise<IndexDeps> => ({ cfg: await deps.cfg(), home: deps.home, isAlive: (pid) => isAlive(deps.control, pid) });
  /** A project as the screens get it: its GitHub page and each service's, from its own clone (null until Phase 0 made it). */
  const projectView = async (idx: IndexDeps, r: ProjectRow) => {
    const ws = workspacePaths(idx.cfg, r.projectId, deps.home);
    const services = r.services ? await Promise.all(r.services.map(async (name) => ({ name, repoUrl: await repoUrlOf(serviceWorkspace(ws, name).repo) }))) : undefined;
    return { ...r, repoUrl: await repoUrlOf(ws.repo), ...(services ? { services } : {}) };
  };
  /** Every draft registers its own root, so one project can have several directories: the spec decides which holds it. */
  const projectDir = async (idx: IndexDeps, projectId: string, specId?: string): Promise<string> => {
    let first: string | null = null;
    for (const { dir } of idx.cfg.projects) {
      const read = await readProject(dir).catch(() => null);
      if (read?.project.projectId !== projectId) continue;
      first ??= dir;
      if (specId === undefined || read.specs.some((s) => s.specId === specId)) return dir;
    }
    if (first !== null) return first;
    throw new HttpError(404, `unknown project ${projectId}`);
  };
  const secretsDirOf = (cfg: Config): string => expandHome(cfg.paths.secrets, deps.home);
  const safe = (id: string): string => {
    if (!SAFE_ID.test(id)) throw new HttpError(400, `invalid id ${JSON.stringify(id)}`);
    return id;
  };
  const cloneProject = deps.cloneProject ?? (async (url, destination) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // The token only travels over https.
    const git = url.startsWith('https:') ? withGitAuth(execCommand, secretsDirOf(await deps.cfg())) : execCommand;
    const result = await git({ bin: 'git', args: ['-c', 'http.followRedirects=false', 'clone', '--depth', '1', '--', url, destination], cwd: path.dirname(destination), env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      deps.log?.(`clone failed: ${redactSecrets(result.stderr.trim(), await loadSecretValues(secretsDirOf(await deps.cfg())))}`);
      throw new HttpError(400, cloneFailure(result.stderr));
    }
  });
  /** Moves a downloaded repository to where the refinement and the runs look for the project's clone. */
  const settleImport = async (cfg: Config, downloaded: string, projectId: string): Promise<string> => {
    const repo = workspacePaths(cfg, projectId, deps.home).repo;
    if (path.resolve(repo) === downloaded) return downloaded;
    if (await fs.access(repo).then(() => true, () => false)) {
      // The id comes from the downloaded repository, so an existing clone is reused only when it came from the same address.
      if ((await originOf(repo)) !== (await originOf(downloaded))) throw new HttpError(409, `já existe um projeto com o id ${projectId} vindo de outro repositório`);
      await fs.rm(downloaded, { recursive: true, force: true });
    } else {
      await fs.mkdir(path.dirname(repo), { recursive: true });
      await fs.rename(downloaded, repo);
    }
    await removeProjectDirs([downloaded], deps.home);
    return repo;
  };
  /** Clones the project's services next to it; returns the ones that failed, which do not stop the import. */
  const cloneServices = async (cfg: Config, remote: string, projectId: string, services: string[]): Promise<string[]> => {
    const ws = workspacePaths(cfg, projectId, deps.home);
    const results = await Promise.all(services.map(async (service) => {
      const repo = serviceWorkspace(ws, service).repo;
      if (await fs.access(path.join(repo, '.git')).then(() => true, () => false)) return null;
      return cloneProject(siblingRepoUrl(remote, repoName(projectId, service)), repo).then(() => null, (err: Error) => {
        deps.log?.(`service ${service} not cloned: ${err.message}`);
        return service;
      });
    }));
    return results.filter((s): s is string => s !== null);
  };
  const events = async (runs: string, runId: string): Promise<StoredEvent[]> => {
    const file = path.join(runs, runId, 'events.ndjson');
    await fs.access(file).catch(() => {
      throw new HttpError(404, `unknown run ${runId}`);
    });
    try {
      return await loadEvents(file);
    } catch (err) {
      if (err instanceof EventLogCorruptError) throw new HttpError(500, 'journal corrupt; run teams-ai status --repair');
      throw err;
    }
  };
  const tokensOf = (evs: StoredEvent[]) => {
    const acc = new Accounting();
    const started = new Map<string, Record<string, unknown>>();
    for (const e of evs) {
      if (e.type === 'STEP_STARTED') started.set(String(e.data.stepId), e.data);
      if (e.type !== 'STEP_FINISHED') continue;
      const s = started.get(String(e.data.stepId));
      const usage = e.data.usage as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
      if (!s || !usage) continue;
      acc.record({
        role: s.role as Role,
        phase: e.data.taskId ? 'phase3' : 'phase',
        taskId: (e.data.taskId as string | null) ?? null,
        attempt: Number(e.data.attempt ?? 0),
        stepKind: e.data.kind as StepKind,
        provider: 'claude',
        model: 'unknown',
        usage,
        costUsd: (e.data.costUsd as number | null) ?? null,
        durationMs: Number(e.data.durationMs ?? 0),
        numTurns: Number(e.data.numTurns ?? 0),
        at: e.at,
      });
    }
    return acc.total();
  };
  const findRun = async (idx: IndexDeps, runId: string): Promise<{ row: RunRow; dir: string }> => {
    const runs = runsDir(idx);
    const evs = await events(runs, runId);
    const projectId = String(evs.find((e) => e.type === 'RUN_STARTED')?.data.projectId ?? '');
    const row = (await listRuns(idx, projectId)).find((r) => r.runId === runId);
    if (!row) throw new HttpError(404, `unknown run ${runId}`);
    return { row, dir: await projectDir(idx, projectId, row.specId) };
  };
  // As generous as waitForRunJournal: a busy host takes well over 10 seconds to start node.
  const waitForJournal = async (runs: string, runId: string, pid: number, timeoutMs = 30_000): Promise<void> => {
    const file = path.join(runs, runId, 'events.ndjson');
    for (let waited = 0; waited < timeoutMs; waited += 200) {
      if (
        await fs.access(file).then(
          () => true,
          () => false,
        )
      )
        return;
      if (!isAlive(deps.control, pid)) break;
      await deps.control.sleep(200);
    }
    // Alive but silent: no pid is written for it, so it would run unmanaged beside the retry this 500 invites.
    // Stop its group and wait for the exit; the caller releases the spec only after this returns.
    if (isAlive(deps.control, pid)) await stop(deps.control, pid);
    const log = await fs.readFile(path.join(runs, runId, 'ui.log'), 'utf8').catch(() => '');
    const tail = redactSecrets(log, await loadSecretValues(secretsDirOf(await deps.cfg()))).slice(-500);
    throw new HttpError(500, `run ${runId} did not start: ${tail || 'no output'}`);
  };
  const launch = async (idx: IndexDeps, o: { projectDir: string; specId: string; runId: string; mode: 'run' | 'resume' | 'complete' | 'readme' | 'deploy'; retryBlocked?: boolean }): Promise<void> => {
    const runs = runsDir(idx);
    await fs.mkdir(path.join(runs, o.runId), { recursive: true });
    const { pid } = spawnRun(deps.control, { ...o, logFile: path.join(runs, o.runId, 'ui.log') });
    await waitForJournal(runs, o.runId, pid).catch(async (err: unknown) => {
      // A resume keeps its directory: it holds the run's journal.
      if (o.mode !== 'resume') await abandonLaunch(deps.control, runs, o.runId, pid);
      throw err;
    });
    await writePid(runs, o.runId, pid);
    deps.log?.(`run ${o.runId} ${o.mode} pid ${pid}`);
  };
  // The 409 checks read the filesystem, which lags a spawn by up to the journal wait; two concurrent
  // requests would both pass. A key is held from the check to the pid write.
  const launching = new Set<string>();
  const exclusive = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (launching.has(key)) throw new HttpError(409, `${key} is already starting`);
    launching.add(key);
    try {
      return await fn();
    } finally {
      launching.delete(key);
    }
  };
  // A concluded spec is read-only: no new run of any kind starts for it.
  const refuseConcluded = (specs: Spec[], rows: RunRow[], specId: string): void => {
    if (concludedSpecs(new Map(specs.map((s) => [s.specId, s.status])), rows).has(specId)) throw new HttpError(409, `spec ${specId} is concluded; create a new spec`);
  };
  // One writer per spec: start, complete and readme share this key, so none of them launches while another one does.
  const specKey = (projectId: string, specId: string): string => `spec ${projectId}/${specId}`;
  const P = '/api';
  return [
    {
      method: 'GET',
      path: `${P}/projects`,
      handler: async ({ json }) => {
        const idx = await index();
        const rows = await listProjects(idx);
        json(200, await Promise.all(rows.map((r) => projectView(idx, r))));
      },
    },
    {
      method: 'POST',
      path: `${P}/projects`,
      handler: async ({ body, json }) => {
        const payload = await body();
        const cfg = await deps.cfg();
        const source: Record<string, unknown> = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
        let dir: string;
        if (typeof source.url === 'string') {
          const url = source.url.trim();
          let remote: URL;
          try {
            remote = new URL(url);
          } catch {
            throw new HttpError(400, 'informe uma URL Git válida');
          }
          const repoPath = remote.pathname.replace(/\/$/, '');
          if (!['https:', 'http:'].includes(remote.protocol) || !remote.hostname || !/^\/[^/]+\/[^/]+(?:\.git)?$/.test(repoPath)) {
            throw new HttpError(400, 'use o formato https://servidor/organização/projeto.git');
          }
          const refused = await refuseCloneHost(remote.hostname, cfg.github.allowedHosts, deps.resolveHost);
          if (refused) throw new HttpError(400, refused);
          const repoName = path.posix.basename(repoPath).replace(/\.git$/, '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'project';
          const suffix = createHash('sha256').update(url).digest('hex').slice(0, 8);
          dir = path.resolve(expandHome(path.posix.join(cfg.paths.workspaces, 'imports', `${repoName}-${suffix}`), deps.home));
          await fs.access(path.join(dir, '.git')).catch(async () => cloneProject(url, dir));
        } else {
          dir = path.resolve(str(payload, 'dir'));
          // Audit M1: only directories inside the workspaces root become projects.
          const root = path.resolve(expandHome(cfg.paths.workspaces, deps.home));
          const real = await fs.realpath(dir).catch(() => null);
          const realRoot = await fs.realpath(root).catch(() => root);
          // A directory that does not exist is left to the project.json read below.
          if (real !== null && !real.startsWith(realRoot + path.sep)) throw new HttpError(400, 'o diretório deve estar dentro de paths.workspaces');
        }
        const read = await readProject(dir).catch((err: Error) => {
          throw new HttpError(400, `${typeof source.url === 'string' ? 'repositório inválido' : 'not a project directory'}: ${err.message.includes('ENOENT') ? `docs/project.json não foi encontrado${typeof source.url === 'string' ? '; se este repositório é um serviço de um sistema, importe o repositório de documentação do projeto, que clona os serviços sozinho' : ''}` : 'docs/project.json inválido'}`);
        });
        let servicesNotCloned: string[] = [];
        if (typeof source.url === 'string') {
          dir = await settleImport(cfg, dir, safe(read.project.projectId));
          const services = read.project.services ?? [];
          servicesNotCloned = await cloneServices(cfg, source.url, read.project.projectId, services);
          const cloned = services.filter((s) => !servicesNotCloned.includes(s));
          if (deps.graphify) buildProjectGraph(deps.graphify, workspacePaths(cfg, read.project.projectId, deps.home), read.project, cloned).catch((err: Error) => deps.log?.(`project graph not built: ${err.message}`));
        }
        await addProject(dir, deps.home);
        if (typeof source.url === 'string' && read.specs.some((s) => s.status === 'planned')) deps.importBacklog?.(read.project.projectId).catch((err: Error) => deps.log?.(`backlog import: ${err.message}`));
        const idx = await index();
        const rows = await listProjects(idx);
        const row = rows.find((r) => r.dir === dir);
        const view = row ? await projectView(idx, row) : { projectId: read.project.projectId, dir, name: read.project.name, description: read.project.vision, specs: [] };
        json(200, { ...view, servicesNotCloned });
      },
    },
    {
      method: 'DELETE',
      path: `${P}/projects/:projectId`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const projectId = params.projectId!;
        const dirs: string[] = [];
        const specIds = new Set<string>();
        const services: string[] = [];
        for (const { dir } of idx.cfg.projects) {
          const read = await readProject(dir).catch(() => null);
          if (read?.project.projectId !== projectId) continue;
          dirs.push(dir);
          for (const s of read.specs) specIds.add(s.specId);
          services.push(...(read.project.services ?? []));
        }
        if (dirs.length === 0) throw new HttpError(404, `unknown project ${projectId}`);
        const runs = runsDir(idx);
        for (const run of (await listRuns(idx, projectId)).filter(claimsSpec)) {
          const pid = await readPid(runs, run.runId);
          if (pid === null || !isAlive(deps.control, pid)) throw new HttpError(409, `project ${projectId} has an active run (${run.runId}) this server cannot stop; stop it before deleting`);
          await markStopRequested(runs, run.runId);
          await stop(deps.control, pid);
          await clearPid(runs, run.runId);
        }
        const ws = workspacePaths(idx.cfg, projectId, deps.home);
        await removeTree(ws.root);
        for (const dir of dirs) await removeTree(dir);
        const gates = expandHome(idx.cfg.paths.gateCache, deps.home);
        await removeTree(gateCacheDir(gates, projectId));
        await removeTree(path.join(gates, 'cargo-root', projectId));
        const runNames =(await fs.readdir(runs).catch(() => [] as string[])).filter((n) => SAFE_ID.test(n));
        for (const runId of runNames) {
          const row = await runRow(idx, runId).catch(() => null);
          // A crashed legacy run names no project; only then does its spec id decide (another project may share it).
          if (row && (row.projectId === projectId || (row.projectId === '' && specIds.has(row.specId)))) await fs.rm(path.join(runs, runId), { recursive: true, force: true });
        }
        await removeProjectDirs(dirs, deps.home);
        await removeProjectSettings(projectId, deps.home);
        await deps.clearChat?.(projectId);
        await teardownProject(deps.exec ?? execCommand, projectId, [...new Set(services)]); // frees the ports; no daemon means nothing runs
        await releaseDeployPort(path.dirname(ws.root), projectId);
        json(200, { deleted: true });
      },
    },
    {
      method: 'GET',
      path: `${P}/projects/:projectId/runs`,
      handler: async ({ params, json }) => {
        const idx = await index();
        await projectDir(idx, params.projectId!);
        json(200, await listRuns(idx, params.projectId!));
      },
    },
    {
      method: 'GET',
      path: `${P}/projects/:projectId/docs`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const projectId = params.projectId!;
        const dir = await projectDir(idx, projectId);
        const repo = workspacePaths(idx.cfg, projectId, deps.home).repo;
        // A failed fetch keeps the last copy of main, so the documents still show.
        await fetchRepo(repo).catch(() => undefined);
        const newestSpec = (await readProject(dir)).specs.at(-1)?.specId;
        const specBriefing = newestSpec !== undefined && SAFE_ID.test(newestSpec) ? `docs/specs/${newestSpec}/briefing.md` : null;
        const present = await mainPaths(repo, [...BACKLOG_DOCS.map((file) => `docs/${file}`), ...(specBriefing ? [specBriefing] : [])]);
        json(200, { docs: await Promise.all(BACKLOG_DOCS.map(async (file) => {
          const at = docPath(file, present, specBriefing);
          return { file, text: present.has(at) ? await showFile(repo, 'origin/main', at) : null };
        })) });
      },
    },
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs/:specId/runs`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const specId = safe(params.specId!);
        const dir = await projectDir(idx, params.projectId!, specId);
        const { specs } = await readProject(dir);
        if (!specs.some((s) => s.specId === specId)) throw new HttpError(404, `unknown spec ${specId}`);
        // A spec a running program owns runs there, ahead of its queue: never a second, loose run beside the program.
        const queued = await deps.queueInProgram?.(params.projectId!, specId);
        if (queued && 'refused' in queued) throw new HttpError(409, queued.refused);
        if (queued) return json(200, { queued: true, draftId: queued.draftId });
        const runId = await exclusive(specKey(params.projectId!, specId), async () => {
          const rows = await listRuns(idx, params.projectId!);
          refuseConcluded(specs, rows, specId);
          // The launched process runs only a running spec; saying so here leaves no dead run behind.
          const status = specs.find((s) => s.specId === specId)!.status;
          if (status !== 'running') throw new HttpError(409, `spec ${specId} is ${status}; only a running spec gets a new run`);
          const active = rows.find((r) => r.specId === specId && claimsSpec(r));
          if (active) throw new HttpError(409, `spec ${specId} already has run ${active.runId} (${active.status})`);
          const id = await nextRunId({ runs: runsDir(idx), projectId: params.projectId! }, specId);
          await launch(idx, { projectDir: dir, specId, runId: id, mode: 'run' });
          return id;
        });
        json(200, { runId });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/resume`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const runs = runsDir(idx);
        await exclusive(`run ${runId}`, async () => {
          await events(runs, runId); // 404 before claiming: the claim is a file in the run directory
          // Shared with the supervisor, which resumes interrupted runs too: whoever holds the claim is the only one to spawn.
          const release = await claimLaunch(runs, runId);
          if (!release) throw new HttpError(409, `run ${runId} is already starting`);
          try {
            const { row, dir } = await findRun(idx, runId);
            if (row.locked) throw new HttpError(409, `run ${runId} belongs to concluded spec ${row.specId}; create a new spec`);
            if (!['paused:auth', 'interrupted', 'verification-failed'].includes(row.status)) throw new HttpError(409, `run ${runId} is ${row.status}; only paused:auth, interrupted or verification-failed runs resume`);
            const later = (await listRuns(idx, row.projectId)).find((r) => r.specId === row.specId && r.kind === row.kind && r.n > row.n);
            if (later) throw new HttpError(409, `run ${runId} is behind ${later.runId} of spec ${row.specId}; only the latest run of a spec resumes`);
            await clearStopRequested(runs, runId); // an explicit resume overrides an earlier Stop
            await launch(idx, { projectDir: dir, specId: row.specId, runId, mode: 'resume', retryBlocked: true });
          } finally {
            await release();
          }
        });
        json(200, { runId });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/gaps/accept`,
      handler: async ({ params, body, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const runs = runsDir(idx);
        const { row } = await findRun(idx, runId);
        if (row.locked) throw new HttpError(409, `run ${runId} belongs to concluded spec ${row.specId}; its gaps are read-only`);
        const accept = AcceptGap.safeParse(await body());
        if (!accept.success) throw new HttpError(400, 'a gap needs its doc, its heading and a note');
        const { doc, heading, note } = accept.data;
        const report = [...(await events(runs, runId))].reverse().find((e) => e.type === 'REPORT_READY')?.data.report as Report | undefined;
        const open = report?.gaps && 'items' in report.gaps && report.gaps.items.some((i) => i.doc === doc && i.heading === heading && i.status !== 'delivered');
        if (!open) throw new HttpError(404, `run ${runId} has no open section ${doc} › ${heading}`);
        const kept = (await readGapDecisions(runs, runId)).filter((d) => d.doc !== doc || d.heading !== heading);
        await fs.writeFile(path.join(runs, runId, 'gap-decisions.json'), `${JSON.stringify([...kept, { doc, heading, note, at: new Date().toISOString() }], null, 2)}\n`);
        json(200, { accepted: true });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/decisions`,
      handler: async ({ params, body, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const asked = (await events(runsDir(idx), runId)).filter((e) => e.type === OrchEvent.DecisionRequested);
        const { row, dir } = await findRun(idx, runId);
        if (row.locked) throw new HttpError(409, `run ${runId} belongs to concluded spec ${row.specId}; create a new spec`);
        const records = answersOf(await body()).map(({ taskId, answer }) => {
          const ask = [...asked].reverse().find((e) => e.data.taskId === taskId);
          if (!ask) throw new HttpError(404, `run ${runId} asked no decision of ${taskId}`);
          return { runId, taskId, specHash: String(ask.data.specHash ?? ""), question: String(ask.data.question), answer };
        });
        await recordOwnerDecisions(dir, row.specId, records);
        json(200, { saved: records.length });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/stop`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        await findRun(idx, runId);
        const runs = runsDir(idx);
        const pid = await readPid(runs, runId);
        if (pid === null || !isAlive(deps.control, pid)) throw new HttpError(409, `run ${runId} has no live process started from the UI`);
        // Before the signal: once the process is gone, the supervisor must already find the user's intent on disk.
        await markStopRequested(runs, runId);
        const how = await stop(deps.control, pid);
        await clearPid(runs, runId);
        json(200, { stopped: true, how: how === 'gone' ? 'terminated' : how });
      },
    },
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs/:specId/complete`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const specId = safe(params.specId!);
        const dir = await projectDir(idx, params.projectId!, specId);
        const runId = await exclusive(specKey(params.projectId!, specId), async () => {
          // Read under the lock: another writer of this spec may be changing the clone or its status.
          const read = await readProject(dir);
          const spec = read.specs.find((s) => s.specId === specId);
          if (!spec) throw new HttpError(404, `unknown spec ${specId}`);
          if (spec.status !== 'awaiting-validation') throw new HttpError(409, `spec ${specId} is ${spec.status}; only awaiting-validation specs complete`);
          const rows = await listRuns(idx, params.projectId!);
          const active = rows.find((r) => r.specId === specId && claimsSpec(r));
          if (active) throw new HttpError(409, `spec ${specId} already has run ${active.runId} (${active.status})`);
          const id = await nextRunId({ runs: runsDir(idx), projectId: params.projectId! }, specId, 'complete');
          await launch(idx, { projectDir: dir, specId, runId: id, mode: 'complete' });
          return id;
        });
        json(202, { runId });
      },
    },
    {
      method: 'POST',
      path: `${P}/runs/:runId/readme`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const evs = await events(runsDir(idx), runId);
        const started = evs.find((e) => e.type === 'RUN_STARTED');
        const projectId = String(started?.data.projectId ?? '');
        const specId = String(started?.data.specId ?? '');
        const dir = await projectDir(idx, projectId, specId);
        // Same rule as spec completion: one writer per spec, because the docs PR resets the shared clone to main.
        const id = await exclusive(specKey(projectId, specId), async () => {
          const rows = await listRuns(idx, projectId);
          refuseConcluded((await readProject(dir)).specs, rows, specId);
          const active = rows.find((r) => r.specId === specId && claimsSpec(r));
          if (active) throw new HttpError(409, `spec ${specId} already has run ${active.runId} (${active.status}); the README is written when it ends`);
          const next = await nextRunId({ runs: runsDir(idx), projectId }, specId, 'readme');
          await launch(idx, { projectDir: dir, specId, runId: next, mode: 'readme' });
          return next;
        });
        json(202, { runId: id });
      },
    },
    {
      method: 'POST',
      path: `${P}/projects/:projectId/specs/:specId/deploy`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const specId = safe(params.specId!);
        const dir = await projectDir(idx, params.projectId!, specId);
        // Deploys main again with no agent (spec deploy), also for a concluded spec: it changes nothing in the spec. Same one-writer-per-spec rule as complete and readme.
        const runId = await exclusive(specKey(params.projectId!, specId), async () => {
          const read = await readProject(dir);
          const spec = read.specs.find((s) => s.specId === specId);
          if (!spec) throw new HttpError(404, `unknown spec ${specId}`);
          const rows = await listRuns(idx, params.projectId!);
          const delivered = spec.status === 'awaiting-validation' || concludedSpecs(new Map(read.specs.map((s) => [s.specId, s.status])), rows).has(specId);
          if (!delivered) throw new HttpError(409, `spec ${specId} is ${spec.status}; only delivered specs deploy again`);
          const active = rows.find((r) => r.specId === specId && claimsSpec(r));
          if (active) throw new HttpError(409, `spec ${specId} already has run ${active.runId} (${active.status})`);
          const id = await nextRunId({ runs: runsDir(idx), projectId: params.projectId! }, specId, 'deploy');
          await launch(idx, { projectDir: dir, specId, runId: id, mode: 'deploy' });
          return id;
        });
        json(202, { runId });
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/service`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const evs = await events(runsDir(idx), safe(params.runId!));
        const deployed = [...evs].reverse().find((e) => e.type === 'DEPLOY_VERIFIED');
        if (!deployed) throw new HttpError(404, 'this run has no deployed service');
        // Reports from before the health path was recorded only prove the host answers: any HTTP status then means online.
        const probe = async (url: string, healthPath: unknown) => {
          const health = typeof healthPath === 'string' ? healthPath : null;
          const get = deps.httpGet ?? httpGet;
          const res = await get(`${url}${health ?? '/'}`, 3000);
          // A web UI exists when the root answers with a page.
          const root = health === null ? res : await get(`${url}/`, 3000);
          return { online: res !== null && (health === null || (res.status >= 200 && res.status < 400)), status: res?.status ?? null, ui: root?.html === true && root.status < 400 };
        };
        const cards = Array.isArray(deployed.data.services) ? (deployed.data.services as Array<{ service: string; url: string; healthcheckPath?: string }>) : null;
        // A services run answers for each service, and is online only when every one answers.
        const checked = cards ? await Promise.all(cards.map(async (c) => ({ service: c.service, ...(await probe(c.url, c.healthcheckPath)) }))) : null;
        const own = checked?.[0] ?? (await probe(String(deployed.data.url), deployed.data.healthcheckPath));
        json(200, { online: checked ? checked.every((c) => c.online) : own.online, status: own.status, ui: own.ui, checkedAt: new Date().toISOString(), ...(checked ? { services: checked } : {}) });
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/artifact`,
      handler: async ({ params, res }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const evs = await events(runsDir(idx), runId);
        const deployed = [...evs].reverse().find((e) => e.type === 'DEPLOY_VERIFIED')?.data;
        if (deployed?.kind !== 'mobile' || typeof deployed.artifact !== 'string') throw new HttpError(404, 'this run has no mobile artifact');
        const name = path.basename(deployed.artifact);
        const data = await fs.readFile(path.join(runsDir(idx), runId, 'artifacts', name)).catch(() => null);
        if (data === null) throw new HttpError(404, 'the artifact is no longer in the run folder');
        res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': `attachment; filename="${name}"`, 'content-length': String(data.length) });
        res.end(data);
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const runs = runsDir(idx);
        const evs = await events(runs, runId);
        const startedEv = evs.find((e) => e.type === 'RUN_STARTED');
        const specId = String(startedEv?.data.specId ?? '');
        const projectId = String(startedEv?.data.projectId ?? '');
        const finished = finishOf(evs) ?? null;
        const state = reduceEvents(evs);
        // A process that died leaves no RUN_FINISHED, so the journal alone reads as running forever; the run list asks the pid files.
        const interrupted = finished === null && (await runLiveness(idx, runId)).interrupted;
        const spec = await projectDir(idx, projectId, specId)
          .then(readProject)
          .then((p) => p.specs.find((s) => s.specId === specId) ?? null)
          .catch(() => null);
        const project = await projectDir(idx, projectId, specId).catch(() => null);
        const plan = project
          ? await fs.readFile(path.join(project, 'docs', 'specs', specId, 'plan.json'), 'utf8')
              .then((text) => AnyPlan.safeParse(JSON.parse(text)).data ?? null)
              .catch(() => null)
          : null;
        const repoUrl = await repoUrlOf(workspacePaths(idx.cfg, projectId, deps.home).repo);
        // docs/README.md as merged on main; the working tree is the fallback for a clone without origin/main.
        const readme = project
          ? await execCommand({ bin: 'git', args: ['show', 'origin/main:docs/README.md'], cwd: project, timeoutMs: 5_000 })
              .then((r) => (r.exitCode === 0 ? r.stdout : null))
              .catch(() => null)
              .then((text) => text ?? fs.readFile(path.join(project, 'docs', 'README.md'), 'utf8').catch(() => null))
          : null;
        // A run with no report of its own (the deploy run of an imported spec) shows the one merged on main.
        const own = [...evs].reverse().find((e) => e.type === 'REPORT_READY')?.data.report;
        const deployed = [...evs].reverse().find((e) => e.type === 'DEPLOY_VERIFIED')?.data;
        const merged = own ?? (project ? await fs.readFile(path.join(project, 'docs', 'specs', specId, 'report.json'), 'utf8').then((t) => JSON.parse(t) as unknown).catch(() => null) : null);
        // The merged report keeps the address of its own deploy; this run's deploy may have used another port.
        const report = own || !deployed ? merged : withDeployedAddress(merged, deployed);
        const phase = [...evs].reverse().find((e) => e.type === 'PHASE_STARTED')?.data.phase ?? 0;
        let status: string = finished ? String(finished.data.result) : interrupted ? 'interrupted' : state.status;
        // Same answer as the run list: a run that delivered a concluded spec is done and locked (see listRuns). A live run is neither.
        const row = finished || interrupted ? (await listRuns(idx, projectId)).find((r) => r.runId === runId) : undefined;
        if (status === 'awaiting-validation') status = row?.status ?? status;
        json(200, {
          runId,
          specId,
          projectId,
          repoUrl,
          readme,
          status,
          locked: row?.locked ?? false,
          agentsDecide: agentsDecideFor(idx.cfg, projectId),
          state: { status: state.status, order: state.order, tasks: state.order.map((id) => state.tasks.get(id)) },
          finished: finished?.data ?? null,
          gapDecisions: await readGapDecisions(runs, runId),
          decisions: await decisionsOf(evs, runId, project, specId),
          tokens: tokensOf(evs),
          acceptanceCriteria: spec?.acceptanceCriteria ?? [],
          plan,
          report,
          phase,
        });
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/test-links`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const evs = await events(runsDir(idx), runId);
        const projectId = String(evs.find((e) => e.type === 'RUN_STARTED')?.data.projectId ?? '');
        const state = reduceEvents(evs);
        const ws = workspacePaths(idx.cfg, projectId, deps.home);
        const groups = testsByRepo(evs, (taskId) => state.tasks.get(taskId)?.def.service);
        const links = await Promise.all([...groups].map(([service, tests]) => testLinksIn(service === '' ? ws.repo : serviceWorkspace(ws, service).repo, tests, deps.log)));
        json(200, Object.fromEntries(links.flat()));
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/events`,
      handler: async ({ req, params, sse }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const runs = runsDir(idx);
        const file = path.join(runs, runId, 'events.ndjson');
        // Taken before the replay read, so the tail resumes there and no event falls between the two.
        const replayed = (await fs.stat(file).catch(() => null))?.size ?? 0;
        const evs = await events(runs, runId);
        const header = req.headers['last-event-id'];
        const after = Number(Array.isArray(header) ? header[0] : (header ?? 0)) || 0;
        const w = sse();
        let last = after;
        let tail: { close(): void } | null = null;
        // A RUN_FINISHED a later reopening cancelled is history: the stream goes on past it.
        const ending = finishOf(evs);
        const cancelled = new Set(evs.filter((e) => e.type === 'RUN_FINISHED' && e !== ending).map((e) => e.seq));
        const send = (e: StoredEvent) => {
          last = e.seq;
          w.send('journal', e, String(e.seq));
          if (e.type === 'RUN_FINISHED' && !cancelled.has(e.seq)) {
            w.send('end', {});
            tail?.close();
            w.close();
          }
        };
        for (const e of evs) if (e.seq > after) send(e);
        if (ending) return;
        tail = tailJournal(file, last, send, { from: replayed });
        w.onClose(() => tail?.close());
      },
    },
    {
      method: 'GET',
      path: `${P}/runs/:runId/steps/:stepId`,
      handler: async ({ params, json }) => {
        const idx = await index();
        const runId = safe(params.runId!);
        const stepId = safe(params.stepId!);
        const dir = path.join(runsDir(idx), runId, 'steps', stepId);
        const prompt = await fs.readFile(path.join(dir, 'prompt.md'), 'utf8').catch(() => null);
        if (prompt === null) throw new HttpError(404, `no step ${stepId} in run ${runId}`);
        const output = await fs
          .readFile(path.join(dir, 'output.json'), 'utf8')
          .then((t) => JSON.parse(t) as unknown)
          .catch(() => null);
        json(200, { prompt, output });
      },
    },
  ];
}
