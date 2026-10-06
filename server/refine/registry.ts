import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunControlDeps } from '../api/run-control.js';
import { spawnRun, waitForRunJournal } from '../api/run-control.js';
import { writePid } from '../api/run-index.js';
import { HttpError } from '../api/server.js';
import type { Config } from '../config/config.js';
import { Spec } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';
import type { Exec } from '../exec/command.js';
import { fetch as gitFetch, git } from '../git/git.js';
import { KnowledgeIndex } from '../knowledge/retrieval.js';
import { expandHome, nextRunId, workspacePaths, type Workspace } from '../orchestrator/workspace.js';
import { loadEvents } from '../store/event-store.js';
import type { RunAgent } from './cycle.js';
import type { CycleDeps } from './cycle.js';
import { cleanDescription, createFromRepo, createNewProject, draftExists, draftPaths, type Draft, type RouteReport } from './draft.js';
import { ConflictError, NotFoundError, RefineSession } from './session.js';
import { reduceRefineEvents, type RefineStatus } from './state.js';

export interface RegistryDeps {
  cfg: () => Promise<Config>;
  home?: string;
  runAgent: RunAgent;
  validateDocs?: CycleDeps['validateDocs'];
  /** Spec 10A.5 decisions 2–4 for every refinement cycle. */
  decider?: CycleDeps['decider'];
  secretsDir: string;
  exec: Exec;
  /** Directory of a registered block A project, or null when the id is not registered. */
  projectDir: (projectId: string) => Promise<string | null>;
  control: RunControlDeps;
  runsDir: () => Promise<string>;
  register: (dir: string) => Promise<void>;
  /** Spec 10A.5 decision 7: classifies a validation report before refinement reopens; absent means no hint. */
  routeReport?: RouteReport;
}

export interface DraftRow {
  projectId: string;
  specId: string;
  state: RefineStatus;
  registered: boolean;
}

const slug = (v: string, what: string) => {
  if (!ID_PATTERNS.SLUG.test(v)) throw new RangeError(`${what} must match ${ID_PATTERNS.SLUG}`);
  return v;
};
const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** Spec (refinement) §5: one live session per spec, opened from disk on demand. */
export class SessionRegistry {
  private readonly sessions = new Map<string, Promise<RefineSession>>();

  constructor(protected readonly deps: RegistryDeps) {}

  protected async ws(projectId: string): Promise<Workspace> {
    return workspacePaths(await this.deps.cfg(), projectId, this.deps.home);
  }

  private session(draft: Draft, ws: Workspace, create?: 'new-project' | 'new-spec' | 'continue'): Promise<RefineSession> {
    const key = `${draft.projectId}/${draft.specId}`;
    const p = (async () => {
      const retrieval = (await exists(ws.knowledgeDb)) ? (q: string) => KnowledgeIndex.open(ws.knowledgeDb).search(q, { k: 5 }) : () => [];
      const deps = { ws, draft, runAgent: this.deps.runAgent, frontAgent: this.deps.runAgent, secretsDir: ws.secrets, retrieval, validateDocs: this.deps.validateDocs, decider: this.deps.decider };
      return create ? RefineSession.create(deps, create) : RefineSession.open(deps);
    })();
    this.sessions.set(key, p);
    p.catch(() => this.sessions.delete(key));
    return p;
  }

  async get(projectId: string, specId: string): Promise<RefineSession> {
    slug(projectId, 'projectId');
    slug(specId, 'specId');
    const cached = this.sessions.get(`${projectId}/${specId}`);
    if (cached) return cached;
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    if (!(await draftExists(draft))) throw new NotFoundError(`no refinement session for ${projectId}/${specId}`);
    return this.session(draft, ws);
  }

  async newProject(projectId: string, name: string, description?: string): Promise<RefineSession> {
    slug(projectId, 'projectId');
    cleanDescription(description);
    if (name.trim() === '') throw new RangeError('name must not be empty');
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, `${projectId}-001`);
    if ((await this.deps.projectDir(projectId)) || (await draftExists(draft)) || (await exists(ws.repo))) {
      throw new ConflictError(`project ${projectId} already exists; register it instead`);
    }
    await createNewProject(draft, name, description);
    return this.session(draft, ws, 'new-project');
  }

  private async specOnMain(ws: Workspace, specId: string): Promise<Spec | null> {
    if (!(await exists(path.join(ws.repo, '.git')))) {
      throw new ConflictError(`project ${ws.projectId} has no workspace clone; run it once from the CLI or add it as a project`);
    }
    await gitFetch(ws.repo, this.deps.exec);
    const text = await git(ws.repo, ['show', `origin/main:docs/specs/${specId}/spec.json`], this.deps.exec).catch(() => null);
    return text === null ? null : Spec.parse(JSON.parse(text));
  }

  async newSpec(projectId: string, specId: string, description?: string): Promise<RefineSession> {
    slug(projectId, 'projectId');
    slug(specId, 'specId');
    cleanDescription(description);
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    if (await draftExists(draft)) throw new ConflictError(`spec ${specId} already has a refinement session`);
    if (await this.specOnMain(ws, specId)) throw new ConflictError(`spec ${specId} already exists on main`);
    await createFromRepo(draft, ws.repo, this.deps.exec, { kind: 'new-spec', description });
    return this.session(draft, ws, 'new-spec');
  }

  async continueSpec(projectId: string, specId: string, report?: string): Promise<RefineSession> {
    slug(projectId, 'projectId');
    slug(specId, 'specId');
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    if (await draftExists(draft)) throw new ConflictError(`spec ${specId} already has a refinement session`);
    const spec = await this.specOnMain(ws, specId);
    if (!spec || (spec.status !== 'awaiting-validation' && spec.status !== 'done')) {
      throw new ConflictError(`spec ${specId} is ${spec?.status ?? 'absent'} on main; only awaiting-validation or done specs continue`);
    }
    await createFromRepo(draft, ws.repo, this.deps.exec, { kind: 'continue', report, route: this.deps.routeReport });
    return this.session(draft, ws, 'continue');
  }

  /** Spec (refinement) §3.6: freeze the spec, spawn `run --draft`, register the draft root as a project. */
  async start(projectId: string, specId: string): Promise<{ runId: string }> {
    const session = await this.get(projectId, specId);
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    await session.freeze();
    const runs = await this.deps.runsDir();
    const runId = await nextRunId({ runs }, specId);
    await fs.mkdir(path.posix.join(runs, runId), { recursive: true });
    const { pid } = spawnRun(this.deps.control, { projectDir: draft.root, specId, runId, mode: 'run', draft: true, logFile: path.posix.join(runs, runId, 'ui.log') });
    try {
      await waitForRunJournal(this.deps.control, runs, runId, pid);
    } catch (err) {
      session.failStart();
      throw new HttpError(500, err instanceof Error ? err.message : String(err));
    }
    await writePid(runs, runId, pid);
    await this.deps.register(draft.root);
    await session.markStarted(runId);
    return { runId };
  }

  /** Discards a draft that never started a run, so the user can begin that spec's refinement again from scratch. */
  async deleteDraft(projectId: string, specId: string): Promise<void> {
    const session = await this.get(projectId, specId);
    if (session.state.status === 'started') throw new ConflictError('session already started a run');
    await session.abort();
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    await session.close();
    this.sessions.delete(`${projectId}/${specId}`);
    await fs.rm(draft.root, { recursive: true, force: true });
  }

  async list(): Promise<DraftRow[]> {
    const cfg = await this.deps.cfg();
    const root = expandHome(cfg.paths.workspaces, this.deps.home);
    const out: DraftRow[] = [];
    for (const projectId of await fs.readdir(root).catch(() => [] as string[])) {
      const refine = path.posix.join(root, projectId, 'refine');
      for (const specId of await fs.readdir(refine).catch(() => [] as string[])) {
        const live = this.sessions.get(`${projectId}/${specId}`);
        const events = live ? (await live).events : await loadEvents(path.posix.join(refine, specId, 'events.ndjson')).catch(() => null);
        if (!events) continue;
        out.push({ projectId, specId, state: reduceRefineEvents(events).status, registered: (await this.deps.projectDir(projectId)) !== null });
      }
    }
    return out;
  }

  /** Releases every journal lock (tests and shutdown). */
  async close(): Promise<void> {
    for (const p of this.sessions.values()) await p.then((s) => s.close()).catch(() => undefined);
    this.sessions.clear();
  }
}
