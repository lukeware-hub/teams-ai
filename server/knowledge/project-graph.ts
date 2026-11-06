import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import type { Project } from '../contracts/project.js';
import { readProject } from '../api/run-index.js';
import { fetch as fetchRepo } from '../git/git.js';
import { readProjectDocs, readSpecFiles, type MainDoc } from '../git/main-docs.js';
import { graphDir, serviceWorkspace, workspacePaths, type Workspace } from '../orchestrator/workspace.js';
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

/** What the project graph reads besides the code: the five documents and every spec, plan and task of main. The chat keeps the five documents only. */
async function projectGraphDocs(located: LocatedProject): Promise<MainDoc[]> {
  return [...(await projectMainDocs(located)), ...(await readSpecFiles(located.ws).catch(() => []))];
}

/** Rebuilds the merged graph from main as it is now: the repository is fetched, then merged with the documents. */
export async function rebuildProjectGraph(graphify: Graphify, located: LocatedProject | null): Promise<void> {
  if (!located) throw new Error('project not found');
  // A failed fetch keeps the last copy of main, so the graph still builds.
  await fetchRepo(located.ws.repo).catch(() => undefined);
  await mergeProjectGraph(graphify, located.ws, located.project, located.project.services ?? [], await projectGraphDocs(located));
}

/** The project's description, its main documents and the graphs its repositories already have, merged into the one graph the chat queries; nothing is written inside a repository. */
export async function mergeProjectGraph(graphify: Graphify, ws: Workspace, project: Project, services: string[], docs: readonly MainDoc[] = []): Promise<void> {
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
  await graphify.merge([...repos, { dir: infoGraph, name: 'project-info' }], path.posix.join(ws.graph, 'project'));
}

/** The project's graph built from main as it is now: the repository is fetched, then every service whose clone is present is built and merged. */
export async function buildLocatedProjectGraph(graphify: Graphify, located: LocatedProject | null): Promise<void> {
  if (!located) throw new Error('project not found');
  // A failed fetch keeps the last copy of main, so the graph still builds.
  await fetchRepo(located.ws.repo).catch(() => undefined);
  const present = await Promise.all((located.project.services ?? []).map(async (service) => ((await fs.access(serviceWorkspace(located.ws, service).repo).then(() => true, () => false)) ? service : null)));
  await buildProjectGraph(graphify, located.ws, located.project, present.filter((s): s is string => s !== null), await projectGraphDocs(located));
}

/** A project graph older than this is rebuilt in the background; a question never waits for it. */
export const GRAPH_TTL_MS = 30 * 60_000;
/** How long the first question of a project waits for its graph to be built. */
export const GRAPH_WAIT_MS = 60_000;

/**
 * Without a graph the caller waits for the build (up to GRAPH_WAIT_MS); with an old one it goes on from it while the build runs.
 * One build per key at a time; a failed build only reaches the log.
 */
export async function ensureFreshGraph(graphFile: string, key: string, build: () => Promise<void>, inFlight: Map<string, Promise<void>>, log?: (line: string) => void): Promise<void> {
  const age = await fs.stat(graphFile).then((s) => Date.now() - s.mtimeMs, () => null);
  if (age !== null && age < GRAPH_TTL_MS) return;
  let running = inFlight.get(key);
  if (!running) {
    running = build()
      .catch((err: Error) => log?.(`project graph not built for ${key}: ${err.message}`))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, running);
  }
  if (age === null) await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, GRAPH_WAIT_MS).unref())]);
}

/** Projects whose graph is being built now, so a button click and a finished run never build the same graph together. */
const building = new Set<string>();

/** Builds the project's graph unless it is already being built; false when it is. */
export async function buildLocatedProjectGraphOnce(graphify: Graphify, located: LocatedProject): Promise<boolean> {
  const id = located.project.projectId;
  if (building.has(id)) return false;
  building.add(id);
  try {
    await buildLocatedProjectGraph(graphify, located);
    return true;
  } finally {
    building.delete(id);
  }
}

/** Rebuilds the graph in the background, so the caller does not wait; a failure goes to log. */
export function refreshProjectGraph(graphify: Graphify, located: LocatedProject, log?: (line: string) => void): void {
  buildLocatedProjectGraphOnce(graphify, located).catch((err: Error) => log?.(`project graph not refreshed: ${err.message}`));
}

/** One code graph of the project: each cloned repository's graph built again, then merged with the project's own description. */
export async function buildProjectGraph(graphify: Graphify, ws: Workspace, project: Project, cloned: string[], docs: readonly MainDoc[] = []): Promise<void> {
  for (const repo of [ws, ...cloned.map((service) => serviceWorkspace(ws, service))]) await graphify.update(repo.repo, graphDir(repo, null));
  await mergeProjectGraph(graphify, ws, project, cloned, docs);
}
