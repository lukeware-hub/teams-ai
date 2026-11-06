import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Graphify } from './graphify.js';

/** One project the global brain may hold: where its merged graph folder is, and whether it is confidential. */
export interface BrainProject {
  projectId: string;
  /** The folder with the project's `graphify-out/graph.json`. */
  graphDir: string;
  confidential: boolean;
}

export interface BrainDeps {
  graphify: Pick<Graphify, 'merge'>;
  /** Every project of the machine; a project whose confidentiality cannot be read must come back as confidential. */
  projects: () => Promise<BrainProject[]>;
  /** The folder of the global brain; the graph is written in `graphify-out/graph.json` inside it. */
  dir: string;
  log?: (line: string) => void;
}

export interface BrainResult {
  included: string[];
  /** Confidential projects and projects with no graph yet. */
  left: string[];
}

export interface BrainFailure {
  at: string;
  message: string;
}

let failure: BrainFailure | null = null;
/** The last global build that failed; a good build clears it. */
export const globalBrainFailure = (): BrainFailure | null => failure;

/** The file the global brain is written to. */
export const globalBrainFile = (dir: string): string => path.join(dir, 'graphify-out', 'graph.json');

/**
 * Merges the graphs of every project that is not confidential into the one global brain. A confidential project is never staged, and
 * when no project is left the old brain is removed, so a project that turns confidential disappears from the brain at once.
 */
export async function rebuildGlobalBrain(deps: BrainDeps): Promise<BrainResult> {
  const projects = await deps.projects();
  const included: BrainProject[] = [];
  const left: string[] = [];
  for (const p of projects) {
    const hasGraph = !p.confidential && (await fs.access(path.join(p.graphDir, 'graphify-out', 'graph.json')).then(() => true, () => false));
    if (hasGraph) included.push(p);
    else left.push(p.projectId);
  }
  try {
    if (included.length === 0) {
      await fs.rm(deps.dir, { recursive: true, force: true });
    } else {
      const merged = await deps.graphify.merge(included.map((p) => ({ dir: p.graphDir, name: p.projectId })), deps.dir);
      if (!merged) throw new Error('graphify could not merge the project graphs');
    }
    failure = null;
  } catch (err) {
    failure = { at: new Date().toISOString(), message: (err as Error).message };
    deps.log?.(`global brain not built: ${failure.message}`);
    throw err;
  }
  return { included: included.map((p) => p.projectId), left };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<unknown> | null = null;
let again = false;

/** Runs the build now, one at a time; a request that comes in while one runs makes it run once more after. */
export async function buildGlobalBrainNow(deps: BrainDeps): Promise<BrainResult | null> {
  if (running) {
    again = true;
    await running.catch(() => undefined);
    return null;
  }
  const build = rebuildGlobalBrain(deps);
  running = build;
  try {
    return await build;
  } finally {
    running = null;
    if (again) {
      again = false;
      void buildGlobalBrainNow(deps).catch(() => undefined);
    }
  }
}

/** Asks for a build soon: many projects finishing together make one build. The build never fails its caller. */
export function scheduleGlobalBrain(deps: BrainDeps, delayMs = 30_000): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void buildGlobalBrainNow(deps).catch(() => undefined);
  }, delayMs);
  timer.unref();
}

/** Only for the tests: forgets the timer, the running build and the failure. */
export function resetGlobalBrainForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  running = null;
  again = false;
  failure = null;
}
