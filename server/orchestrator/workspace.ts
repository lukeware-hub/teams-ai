import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { stepId } from '../core/ids.js';

export interface Workspace {
  projectId: string;
  root: string;
  repo: string;
  worktrees: string;
  graph: string;
  knowledgeDb: string;
  runs: string;
}

export function expandHome(p: string, home: string = os.homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? path.posix.join(home, p.slice(2)) : p;
}

/** Spec §3: everything for a project under workspaces/<projectId>; runs are global, keyed by runId. */
export function workspacePaths(cfg: Config, projectId: string, home?: string): Workspace {
  const root = path.posix.join(expandHome(cfg.paths.workspaces, home), projectId);
  return {
    projectId,
    root,
    repo: path.posix.join(root, 'repo'),
    worktrees: path.posix.join(root, 'worktrees'),
    graph: path.posix.join(root, 'graph'),
    knowledgeDb: path.posix.join(root, 'knowledge.sqlite'),
    runs: expandHome(cfg.paths.runs, home),
  };
}

const branchDir = (branch: string) => branch.replace(/\//g, '__');

export function worktreeDir(ws: Workspace, branch: string): string {
  return path.posix.join(ws.worktrees, branchDir(branch));
}

export function graphDir(ws: Workspace, branch: string | null): string {
  return branch === null ? path.posix.join(ws.graph, 'main') : path.posix.join(ws.graph, 'worktrees', branchDir(branch));
}

export function runDir(ws: Workspace, runId: string): string {
  return path.posix.join(ws.runs, runId);
}

export function eventsFile(ws: Workspace, runId: string): string {
  return path.posix.join(runDir(ws, runId), 'events.ndjson');
}

export function stateFile(ws: Workspace, runId: string): string {
  return path.posix.join(runDir(ws, runId), 'state.json');
}

export function stepDir(ws: Workspace, runId: string, seq: number): string {
  return path.posix.join(runDir(ws, runId), 'steps', stepId(seq));
}

/** `<specId>-r<n>`, n = 1 + the highest existing run number for that spec. */
export async function nextRunId(ws: Workspace, specId: string): Promise<string> {
  let names: string[] = [];
  try {
    names = await fs.readdir(ws.runs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const re = new RegExp(`^${specId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-r(\\d+)$`);
  const max = names
    .map((n) => re.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .reduce((acc, m) => Math.max(acc, Number(m[1])), 0);
  return `${specId}-r${max + 1}`;
}
