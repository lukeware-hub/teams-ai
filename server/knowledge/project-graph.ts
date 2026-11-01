import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import type { Project } from '../contracts/project.js';
import { readProject } from '../api/run-index.js';
import { fetch as fetchRepo } from '../git/git.js';
import { readMainDocs, type MainDoc } from '../git/main-docs.js';
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
  return readMainDocs(located.ws.repo, located.newestSpec).catch(() => []);
}

/** Rebuilds the merged graph from main as it is now: the repository is fetched, then merged with the documents. */
export async function rebuildProjectGraph(graphify: Graphify, located: LocatedProject | null): Promise<void> {
  if (!located) throw new Error('project not found');
  // A failed fetch keeps the last copy of main, so the graph still builds.
  await fetchRepo(located.ws.repo).catch(() => undefined);
  await mergeProjectGraph(graphify, located.ws, located.project, located.project.services ?? [], await projectMainDocs(located));
}

/** The project's description, its main documents and the graphs its repositories already have, merged into the one graph the chat queries; nothing is written inside a repository. */
export async function mergeProjectGraph(graphify: Graphify, ws: Workspace, project: Project, services: string[], docs: readonly MainDoc[] = []): Promise<void> {
  const info = path.posix.join(ws.graph, 'project-info');
  await fs.rm(info, { recursive: true, force: true });
  await fs.mkdir(info, { recursive: true });
  await fs.writeFile(path.join(info, 'projeto.md'), projectInfoMarkdown(project));
  for (const doc of docs) if (doc.text !== null) await fs.writeFile(path.join(info, doc.file), doc.text);
  const infoGraph = path.posix.join(ws.graph, 'project-info-graph');
  await graphify.update(info, infoGraph);
  const repos = [{ dir: graphDir(ws, null), name: project.projectId }, ...services.map((service) => ({ dir: graphDir(serviceWorkspace(ws, service), null), name: service }))];
  await graphify.merge([...repos, { dir: infoGraph, name: 'project-info' }], path.posix.join(ws.graph, 'project'));
}

/** One code graph of the project: each cloned repository's graph built again, then merged with the project's own description. */
export async function buildProjectGraph(graphify: Graphify, ws: Workspace, project: Project, cloned: string[], docs: readonly MainDoc[] = []): Promise<void> {
  for (const repo of [ws, ...cloned.map((service) => serviceWorkspace(ws, service))]) await graphify.update(repo.repo, graphDir(repo, null));
  await mergeProjectGraph(graphify, ws, project, cloned, docs);
}
