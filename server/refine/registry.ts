import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunControlDeps } from '../api/run-control.js';
import { abandonLaunch, isAlive, spawnRun, waitForRunJournal } from '../api/run-control.js';
import { ProgramService, programFile, type ProgramDecision, type ProgramView } from '../program/service.js';
import type { Program } from '../program/controller.js';
import { claimsSpec, listRuns, writePid } from '../api/run-index.js';
import { HttpError } from '../api/server.js';
import type { Config } from '../config/config.js';
import { Spec } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';
import type { Exec } from '../exec/command.js';
import { fetch as gitFetch, git } from '../git/git.js';
import { openProjectKnowledge } from '../knowledge/project-docs.js';
import { KnowledgeIndex } from '../knowledge/retrieval.js';
import { expandHome, nextRunId, workspacePaths, type Workspace } from '../orchestrator/workspace.js';
import { loadEvents } from '../store/event-store.js';
import { currentEvent } from './events.js';
import { answerFloor } from './auto-floor.js';
import type { HealTarget } from './heal-driver.js';
import type { RunAgent } from './cycle.js';
import type { CycleDeps } from './cycle.js';
import { cleanDescription, createFromRepo, createNewProject, draftExists, draftPaths, refineRoot, syncWithMain, type Draft, type RouteReport } from './draft.js';
import { suggestName, type NameKind, type NameSuggestion } from './naming.js';
import { ConflictError, NotFoundError, RefineSession } from './session.js';
import { reduceRefineEvents, type RefineStatus } from './state.js';
import { refineLimits } from './limits.js';

export interface RegistryDeps {
  /** Extracts the documents of a folder into a graph folder for a repository session (plan increment B). */
  extractDocs?: (dir: string, outDir: string) => Promise<void>;
  cfg: () => Promise<Config>;
  home?: string;
  runAgent: RunAgent;
  validateDocs?: CycleDeps['validateDocs'];
  /** The Jev's score of the documents, journaled once per cycle of a new project or a backlog. */
  scoreDocs?: CycleDeps['scoreDocs'];
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
/** Opens the index for one query only, so no file handle stays open between turns. */
const searchKnowledge = (file: string, query: string) => {
  const knowledge = KnowledgeIndex.open(file);
  try {
    return knowledge.search(query, { k: 5 });
  } finally {
    knowledge.close();
  }
};

/** Every step of one refinement session belongs to its project, so its agent settings apply. */
const inProject =
  (run: RunAgent, projectId: string): RunAgent =>
  (req, ctx) =>
    run(req, { ...ctx, projectId });

/** Spec (refinement) §5: one live session per spec, opened from disk on demand. */
export class SessionRegistry {
  private readonly sessions = new Map<string, Promise<RefineSession>>();

  private readonly programs: ProgramService;

  constructor(protected readonly deps: RegistryDeps) {
    this.programs = new ProgramService({
      cfg: deps.cfg,
      home: deps.home,
      control: deps.control,
      register: deps.register,
      decider: deps.decider,
      draftRoot: async (projectId, draftId) => draftPaths(await this.ws(projectId), draftId).root,
      freezeItem: async (projectId, draftId, specId) => void (await (await this.get(projectId, draftId)).freezeItem(specId)),
    });
  }

  protected async ws(projectId: string): Promise<Workspace> {
    return workspacePaths(await this.deps.cfg(), projectId, this.deps.home);
  }

  private session(draft: Draft, ws: Workspace, create?: 'new-project' | 'new-spec' | 'continue' | 'backlog'): Promise<RefineSession> {
    const key = `${draft.projectId}/${draft.specId}`;
    const p = (async () => {
      // The clone of main holds the merged specs and ADRs; before the first clone there is no history to check against.
      // Its own file: the run indexes another folder, and each index drops the documents it does not find.
      const file = path.posix.join(ws.root, 'refine-knowledge.sqlite');
      if (await exists(ws.repo)) (await openProjectKnowledge(file, ws.repo)).close();
      const retrieval = (await exists(file)) ? (q: string) => searchKnowledge(file, q) : () => [];
      const runAgent = inProject(this.deps.runAgent, draft.projectId);
      const deps = { ws, draft, runAgent, frontAgent: runAgent, secretsDir: ws.secrets, retrieval, extractDocs: this.deps.extractDocs, validateDocs: this.deps.validateDocs, scoreDocs: this.deps.scoreDocs, decider: this.deps.decider, autoAnswerFloor: async () => answerFloor(await this.deps.cfg(), refineRoot(ws)), limits: refineLimits(), exec: this.deps.exec, speckitAgents: async () => (await this.deps.cfg()).concurrency.planAgents };
      return create ? RefineSession.create(deps, create) : RefineSession.open(deps);
    })();
    this.sessions.set(key, p);
    // Only drop the entry this attempt added: a later attempt's entry must survive this one failing.
    p.catch(() => { if (this.sessions.get(key) === p) this.sessions.delete(key); });
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
    // A concurrent get may have opened it during the awaits above; opening twice would fail on the journal lock.
    return this.sessions.get(`${projectId}/${specId}`) ?? this.session(draft, ws);
  }

  /** Roadmap R11.12: a readable English id for a new project (plus its first spec) or a new spec of `projectId`. */
  async suggestName(kind: NameKind, input: { projectId?: string; name: string; description: string }): Promise<NameSuggestion> {
    cleanDescription(input.description);
    if (input.name.trim() === '' && input.description.trim() === '') throw new RangeError('name or description is required');
    const cfg = await this.deps.cfg();
    const root = expandHome(cfg.paths.workspaces, this.deps.home);
    let taken: string[];
    if (kind === 'project') {
      taken = await fs.readdir(root).catch(() => [] as string[]);
    } else {
      const ws = await this.ws(slug(input.projectId ?? '', 'projectId'));
      const drafts = await fs.readdir(path.posix.join(ws.root, 'refine')).catch(() => [] as string[]);
      const onMain = await fs.readdir(path.posix.join(ws.repo, 'docs', 'specs')).catch(() => [] as string[]);
      taken = [...drafts, ...onMain];
    }
    return suggestName({ runAgent: this.deps.runAgent, workspacesRoot: root, model: cfg.decisions.modelTiers.small }, { kind, ...input, taken });
  }

  async newProject(projectId: string, name: string, description?: string, firstSpecId?: string): Promise<RefineSession> {
    slug(projectId, 'projectId');
    if (firstSpecId) slug(firstSpecId, 'firstSpecId');
    cleanDescription(description);
    if (name.trim() === '') throw new RangeError('name must not be empty');
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, firstSpecId || `${projectId}-001`);
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
    const spec = await this.specOnMain(ws, specId);
    if (spec?.status === 'done') throw new ConflictError(`spec ${specId} is concluded; create a new spec`);
    if (spec?.status !== 'awaiting-validation') throw new ConflictError(`spec ${specId} is ${spec?.status ?? 'absent'} on main; only awaiting-validation specs continue`);
    const draft = draftPaths(ws, specId);
    if (await draftExists(draft)) {
      const session = await this.get(projectId, specId);
      if (session.state.status !== 'started') {
        if (report) throw new ConflictError(`a spec ${specId} já tem um refinamento em andamento; abra-o pelo Continuar spec ou use Reiniciar para recomeçar com o relatório`);
        return session;
      }
      // The run of this draft is over: a new refinement starts from main.
      await this.assertNoActiveRun(projectId, specId);
      await this.discardDraft(projectId, specId, session);
    }
    await createFromRepo(draft, ws.repo, this.deps.exec, { kind: 'continue', report, route: this.deps.routeReport });
    return this.session(draft, ws, 'continue');
  }

  /** R11.4: starts the program of a detailed backlog; the first item's run is the one the screen follows. */
  private async startProgram(projectId: string, specId: string, session: RefineSession): Promise<{ runId: string; program: Program }> {
    const entries = await session.freezeProgram();
    try {
      const program = await this.programs.start(projectId, specId, entries);
      const runId = program.items.find((i) => i.runId !== null)?.runId ?? null;
      if (runId === null) {
        // Nothing was launched (docker or the login are down): drop the ledger so the next start begins clean.
        await fs.rm(programFile(draftPaths(await this.ws(projectId), specId).root), { force: true });
        throw new HttpError(500, `o programa não iniciou nenhuma run: ${program.items.find((i) => i.reason)?.reason ?? 'sem motivo registrado'}`);
      }
      await session.markStarted(runId);
      return { runId, program };
    } catch (err) {
      session.failStart();
      throw err;
    }
  }

  async program(projectId: string, specId: string): Promise<ProgramView | null> {
    await this.get(projectId, specId);
    return this.programs.view(projectId, specId);
  }

  async programDecisions(projectId: string, specId: string): Promise<{ decisions: ProgramDecision[]; unanswered: number }> {
    await this.get(projectId, specId);
    return this.programs.decisions(projectId, specId);
  }

  /** R11.4 continuation: retries one failed item of a started program. */
  async retryProgramItem(projectId: string, specId: string, itemSpecId: string): Promise<ProgramView> {
    await this.get(projectId, specId);
    await this.programs.retry(projectId, specId, itemSpecId);
    return (await this.programs.view(projectId, specId))!;
  }

  /** Puts one pending item of a started program ahead of its queue; the answer is the view the screens read. */
  async prioritizeProgramItem(projectId: string, specId: string, itemSpecId: string): Promise<ProgramView> {
    await this.get(projectId, specId);
    await this.programs.prioritize(projectId, specId, itemSpecId);
    return (await this.programs.view(projectId, specId))!;
  }

  /**
   * A spec a started program of this project holds runs there: queued, waiting or failed, it goes ahead of the queue; blocked, the
   * answer says why. Null when no program holds it, or its run is already under way or done.
   */
  async queueInProgram(projectId: string, itemSpecId: string): Promise<{ draftId: string } | { refused: string } | null> {
    for (const row of await this.list()) {
      if (row.projectId !== projectId || row.state !== 'started') continue;
      const item = (await this.programs.read(projectId, row.specId))?.items.find((i) => i.specId === itemSpecId);
      if (item?.status === 'blocked') return { refused: `A spec ${itemSpecId} está bloqueada no programa: ${item.reason}. Rode antes a spec da qual ela depende.` };
      if (item?.status !== 'pending' && item?.status !== 'failed' && item?.status !== 'waiting') continue;
      await this.programs.prioritize(projectId, row.specId, itemSpecId);
      return { draftId: row.specId };
    }
    return null;
  }

  /** One reconciliation of every started backlog program: the UI server calls it on a timer and once at boot. */
  async tickPrograms(): Promise<void> {
    // A broken config.json must not reject the timer's tick: it is logged and read again on the next one.
    const rows = await this.list().catch((err) => {
      console.error(`programs tick: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    for (const row of rows) {
      if (row.state !== 'started') continue;
      await this.programs.tick(row.projectId, row.specId).catch((err) => console.error(`program ${row.projectId}/${row.specId}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  /** Spec (refinement) §3.6: freeze the spec, spawn `run --draft`, register the draft root as a project. */
  async start(projectId: string, specId: string): Promise<{ runId: string; program?: Program }> {
    const session = await this.get(projectId, specId);
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    await session.syncWithMain(() => syncWithMain(draft, ws.repo, this.deps.exec));
    if (session.state.backlog?.enabled) return this.startProgram(projectId, specId, session);
    if (session.state.mode === 'new-project') throw new ConflictError('O backlog ainda não está pronto: avalie o projeto até ele ficar pronto antes de iniciar a análise.');
    await session.freeze();
    const runs = await this.deps.runsDir();
    const runId = await nextRunId({ runs, projectId }, specId);
    await fs.mkdir(path.posix.join(runs, runId), { recursive: true });
    const { pid } = spawnRun(this.deps.control, { projectDir: draft.root, specId, runId, mode: 'run', draft: true, logFile: path.posix.join(runs, runId, 'ui.log') });
    // Any failure until the session records the run stops it, so the session never stays locked by a start.
    try {
      await waitForRunJournal(this.deps.control, runs, runId, pid, this.deps.secretsDir);
      await writePid(runs, runId, pid);
      await this.deps.register(draft.root);
      await session.markStarted(runId);
    } catch (err) {
      await abandonLaunch(this.deps.control, runs, runId, pid);
      session.failStart();
      throw new HttpError(500, err instanceof Error ? err.message : String(err));
    }
    return { runId };
  }

  /**
   * A git import with a planned backlog prepares it: its docs become a backlog draft, enabled here, and the outline and detail
   * run in the background. The session then waits for a person to start the program with Iniciar análise. One session per project.
   */
  async startImportedBacklog(projectId: string): Promise<void> {
    if ((await this.list()).some((row) => row.projectId === projectId)) return;
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, `${projectId}-backlog`);
    await createFromRepo(draft, ws.repo, this.deps.exec, { kind: 'backlog' });
    const session = await this.session(draft, ws, 'backlog');
    await session.enableBacklog();
    // Many agent calls: the import does not wait for them.
    session.evaluate().catch((err: Error) => console.error(`backlog import ${projectId}: ${err.message}`));
  }

  /** Discards a draft that never started a run, so the user can begin that spec's refinement again from scratch. */
  async deleteDraft(projectId: string, specId: string): Promise<void> {
    const session = await this.get(projectId, specId);
    if (session.state.status === 'started') throw new ConflictError('session already started a run');
    await this.discardDraft(projectId, specId, session);
  }

  private async discardDraft(projectId: string, specId: string, session: RefineSession): Promise<void> {
    session.beginDiscard();
    await session.abort();
    const draft = draftPaths(await this.ws(projectId), specId);
    await session.close();
    this.sessions.delete(`${projectId}/${specId}`);
    await fs.rm(draft.root, { recursive: true, force: true });
  }

  /** Throws the draft away even after it started a run, then reopens the spec's refinement from main. An interrupted run does not block: it is dead. */
  async restartSpec(projectId: string, specId: string): Promise<RefineSession> {
    slug(projectId, 'projectId');
    slug(specId, 'specId');
    await this.assertNoActiveRun(projectId, specId);
    const session = await this.get(projectId, specId).catch((err) => (err instanceof NotFoundError ? null : Promise.reject(err)));
    if (session) await this.discardDraft(projectId, specId, session);
    return this.continueSpec(projectId, specId);
  }

  /** An interrupted run does not count: it is dead. */
  private async assertNoActiveRun(projectId: string, specId: string): Promise<void> {
    const index = { cfg: await this.deps.cfg(), home: this.deps.home, isAlive: (pid: number) => isAlive(this.deps.control, pid) };
    const active = (await listRuns(index, projectId)).find((r) => r.specId === specId && claimsSpec(r) && r.status !== 'interrupted');
    if (active) throw new ConflictError(`a spec ${specId} tem a run ${active.runId} em andamento; pare a run antes`);
  }

  /** Every draft as the heal driver sees it: opened once, and kept open, so each tick reads its journal in memory. */
  async healTargets(): Promise<HealTarget[]> {
    const out: HealTarget[] = [];
    for (const row of await this.list()) {
      const session = await this.get(row.projectId, row.specId).catch(() => null);
      if (session === null) continue;
      out.push({
        key: `${row.projectId}/${row.specId}`,
        view: () => session.healView(),
        evaluate: () => session.evaluate(),
        prepare: () => session.runPlans(),
        pause: (reason) => session.pauseHeal(reason),
      });
    }
    return out;
  }

  async list(): Promise<DraftRow[]> {
    const cfg = await this.deps.cfg();
    const root = expandHome(cfg.paths.workspaces, this.deps.home);
    const out: DraftRow[] = [];
    for (const projectId of await fs.readdir(root).catch(() => [] as string[])) {
      const refine = path.posix.join(root, projectId, 'refine');
      for (const specId of await fs.readdir(refine).catch(() => [] as string[])) {
        const live = this.sessions.get(`${projectId}/${specId}`);
        const events = live ? (await live).events : await loadEvents(path.posix.join(refine, specId, 'events.ndjson')).then((es) => es.map(currentEvent)).catch(() => null);
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
