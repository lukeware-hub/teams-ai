import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import type { Project } from '../contracts/project.js';
import { readProject } from '../api/run-index.js';
import { fetch as fetchRepo } from '../git/git.js';
import { readProjectDocs, readSpecFiles, type MainDoc } from '../git/main-docs.js';
import { graphDir, graphFile, serviceWorkspace, workspacePaths, type Workspace } from '../orchestrator/workspace.js';
import type { ChatMessage } from '../chat/store.js';
import { linkBrainFile } from './brain-links.js';
import { brainNotes, type BrainLink, type RunJournal } from './brain-notes.js';
import type { Graphify } from './graphify.js';
import { projectInfoMarkdown } from './project-info.js';

/** A configured project with its workspace and the spec whose briefing stands in for a missing root one. */
export interface LocatedProject {
  ws: Workspace;
  project: Project;
  newestSpec: string | undefined;
}

/** The configured project with this id, or null when no project of the configuration has it. */
export async function locateProject(cfg: Config, projectId: string): Promise<LocatedProject | null> {
  for (const { dir } of cfg.projects) {
    const read = await readProject(dir).catch(() => null);
    if (read?.project.projectId === projectId) return { ws: workspacePaths(cfg, projectId), project: read.project, newestSpec: read.specs.at(-1)?.specId };
  }
  return null;
}

/** The project's main documents as origin/main has them; a project that is not located, or cannot be read, has none. */
export async function projectMainDocs(located: LocatedProject | null): Promise<MainDoc[]> {
  if (!located) return [];
  return readProjectDocs(located.ws, located.newestSpec).catch(() => []);
}

/** What the brain notes of a project are written from: its run journals and, unless it is confidential, its chat. */
export type BrainSource = (projectId: string) => Promise<{ runs: RunJournal[]; chat: ChatMessage[] | null }>;

let brainSource: BrainSource | null = null;

/** Where the notes of the brain come from; set once when the server starts. Without it the graph has no notes. */
export function setBrainSource(source: BrainSource | null): void {
  brainSource = source;
}

/**
 * What the project graph reads besides the code: the five documents, every spec, plan and task of main, and the brain notes
 * (tasks, run history and failures, costs, chat). The notes are an extra: a source that fails leaves the graph without them.
 */
async function projectGraphDocs(located: LocatedProject): Promise<{ docs: MainDoc[]; links: BrainLink[] }> {
  const docs = [...(await projectMainDocs(located)), ...(await readSpecFiles(located.ws).catch(() => []))];
  if (!brainSource) return { docs, links: [] };
  try {
    const notes = brainNotes(await brainSource(located.project.projectId));
    return { docs: [...docs, ...notes.docs], links: notes.links };
  } catch {
    return { docs, links: [] };
  }
}

/** Rebuilds the merged graph from main as it is now: the repository is fetched, then merged with the documents. */
export async function rebuildProjectGraph(graphify: Graphify, located: LocatedProject | null): Promise<void> {
  if (!located) throw new Error('project not found');
  // A failed fetch keeps the last copy of main, so the graph still builds.
  await fetchRepo(located.ws.repo).catch(() => undefined);
  const { docs, links } = await projectGraphDocs(located);
  await mergeProjectGraph(graphify, located.ws, located.project, located.project.services ?? [], docs, links);
}

/** The project's description, its main documents and the graphs its repositories already have, merged into the one graph the chat queries; nothing is written inside a repository. */
export async function mergeProjectGraph(graphify: Graphify, ws: Workspace, project: Project, services: string[], docs: readonly MainDoc[] = [], links: readonly BrainLink[] = []): Promise<void> {
  const info = path.posix.join(ws.graph, 'project-info');
  await fs.rm(info, { recursive: true, force: true });
  await fs.mkdir(info, { recursive: true });
  await fs.writeFile(path.join(info, 'projeto.md'), projectInfoMarkdown(project));
  for (const doc of docs) {
    if (doc.text === null) continue;
    await fs.mkdir(path.dirname(path.join(info, doc.file)), { recursive: true });
    await fs.writeFile(path.join(info, doc.file), doc.text);
  }
  const infoGraph = path.posix.join(ws.graph, 'project-info-graph');
  await graphify.update(info, infoGraph);
  const repos = [{ dir: graphDir(ws, null), name: project.projectId }, ...services.map((service) => ({ dir: graphDir(serviceWorkspace(ws, service), null), name: service }))];
  const merged = path.posix.join(ws.graph, 'project');
  await graphify.merge([...repos, { dir: infoGraph, name: 'project-info' }], merged);
  // graphify links notes to code only when both are extracted together, so the task links are added to the merged graph here.
  await linkBrainFile(graphFile(merged), links).catch(() => 0);
}

/** The project's graph built from main as it is now: the repository is fetched, then every service whose clone is present is built and merged. */
export async function buildLocatedProjectGraph(graphify: Graphify, located: LocatedProject | null): Promise<void> {
  if (!located) throw new Error('project not found');
  // A failed fetch keeps the last copy of main, so the graph still builds.
  await fetchRepo(located.ws.repo).catch(() => undefined);
  const present = await Promise.all((located.project.services ?? []).map(async (service) => ((await fs.access(serviceWorkspace(located.ws, service).repo).then(() => true, () => false)) ? service : null)));
  const { docs, links } = await projectGraphDocs(located);
  await buildProjectGraph(graphify, located.ws, located.project, present.filter((s): s is string => s !== null), docs, links);
}

/** A project graph older than this is rebuilt in the background; a question never waits for it. */
export const GRAPH_TTL_MS = 30 * 60_000;
/** How long the first question of a project waits for its graph to be built. */
export const GRAPH_WAIT_MS = 60_000;
/** After a build that wrote no graph (a project with no code yet), nobody waits for or starts another one for this long. */
export const GRAPH_EMPTY_MS = 5 * 60_000;
const emptyUntil = new Map<string, number>();

/**
 * Without a graph the caller waits for the build (up to GRAPH_WAIT_MS); with an old one it goes on from it while the build runs.
 * One build per key at a time; a failed build only reaches the log.
 */
export async function ensureFreshGraph(graphFile: string, key: string, build: () => Promise<void>, inFlight: Map<string, Promise<void>>, log?: (line: string) => void): Promise<void> {
  const age = await fs.stat(graphFile).then((s) => Date.now() - s.mtimeMs, () => null);
  if (age !== null && age < GRAPH_TTL_MS) return;
  // A build that just ended without a graph would end the same way again: no wait on every question.
  if (age === null && (emptyUntil.get(key) ?? 0) > Date.now()) return;
  let running = inFlight.get(key);
  if (!running) {
    running = build()
      .then(async () => {
        const wrote = await fs.access(graphFile).then(() => true, () => false);
        if (wrote) emptyUntil.delete(key);
        else emptyUntil.set(key, Date.now() + GRAPH_EMPTY_MS);
      })
      .catch((err: Error) => log?.(`project graph not built for ${key}: ${err.message}`))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, running);
  }
  if (age === null) await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, GRAPH_WAIT_MS).unref())]);
}

/** How long a run waits for a missing graph before it goes on with the text search; the build keeps going in the background. */
export const GRAPH_RUN_WAIT_MS = 90_000;

/**
 * Builds the graph of the project when it has none, so the first task of a run already gets code context. It waits at most
 * `timeoutMs`; a build that fails is already recorded by `buildLocatedProjectGraphOnce`, and the run goes on without it.
 */
export async function ensureProjectGraph(graphify: Graphify, located: LocatedProject, opts: { timeoutMs?: number; log?: (line: string) => void } = {}): Promise<void> {
  const file = graphFile(path.posix.join(located.ws.graph, 'project'));
  if (await fs.access(file).then(() => true, () => false)) return;
  const build = buildLocatedProjectGraphOnce(graphify, located).then(() => undefined, (err: Error) => opts.log?.(`project graph not built before the run: ${err.message}`));
  await Promise.race([build, new Promise<void>((resolve) => setTimeout(resolve, opts.timeoutMs ?? GRAPH_RUN_WAIT_MS).unref())]);
}

/** Projects whose graph is being built now, so a button click and a finished run never build the same graph together. */
const building = new Set<string>();

/** The last build that failed for each project; a good build clears it, so the screen can warn the owner. */
const failures = new Map<string, GraphFailure>();

export interface GraphFailure {
  at: string;
  message: string;
}

export const graphFailure = (projectId: string): GraphFailure | null => failures.get(projectId) ?? null;

export function recordGraphFailure(projectId: string, err: Error): void {
  failures.set(projectId, { at: new Date().toISOString(), message: err.message });
}

/** Builds the project's graph unless it is already being built; false when it is. */
export async function buildLocatedProjectGraphOnce(graphify: Graphify, located: LocatedProject): Promise<boolean> {
  const id = located.project.projectId;
  if (building.has(id)) return false;
  building.add(id);
  try {
    await buildLocatedProjectGraph(graphify, located);
    failures.delete(id);
    return true;
  } catch (err) {
    recordGraphFailure(id, err as Error);
    throw err;
  } finally {
    building.delete(id);
  }
}

/** Rebuilds the graph in the background, so the caller does not wait; a failure goes to log. */
export function refreshProjectGraph(graphify: Graphify, located: LocatedProject, log?: (line: string) => void): void {
  buildLocatedProjectGraphOnce(graphify, located).catch((err: Error) => log?.(`project graph not refreshed: ${err.message}`));
}

/** One code graph of the project: each cloned repository's graph built again, then merged with the project's own description. */
export async function buildProjectGraph(graphify: Graphify, ws: Workspace, project: Project, cloned: string[], docs: readonly MainDoc[] = [], links: readonly BrainLink[] = []): Promise<void> {
  for (const repo of [ws, ...cloned.map((service) => serviceWorkspace(ws, service))]) await graphify.update(repo.repo, graphDir(repo, null));
  await mergeProjectGraph(graphify, ws, project, cloned, docs, links);
}
