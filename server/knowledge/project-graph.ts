import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Project } from '../contracts/project.js';
import { graphDir, serviceWorkspace, type Workspace } from '../orchestrator/workspace.js';
import type { Graphify } from './graphify.js';
import { projectInfoMarkdown } from './project-info.js';

/** One code graph of the project: each cloned repository's graph and the project's own description, merged so the chat can query all of it. */
export async function buildProjectGraph(graphify: Graphify, ws: Workspace, project: Project, cloned: string[]): Promise<void> {
  const repos = [ws, ...cloned.map((service) => serviceWorkspace(ws, service))];
  for (const repo of repos) await graphify.update(repo.repo, graphDir(repo, null));
  const info = path.posix.join(ws.graph, 'project-info');
  await fs.mkdir(info, { recursive: true });
  await fs.writeFile(path.join(info, 'projeto.md'), projectInfoMarkdown(project));
  const infoGraph = path.posix.join(ws.graph, 'project-info-graph');
  await graphify.update(info, infoGraph);
  await graphify.merge([...repos.map((repo) => graphDir(repo, null)), infoGraph], path.posix.join(ws.graph, 'project'));
}
