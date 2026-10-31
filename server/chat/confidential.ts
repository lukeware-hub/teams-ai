import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readProject } from '../api/run-index.js';
import type { Config } from '../config/config.js';
import { workspacePaths } from '../orchestrator/workspace.js';
import { currentEvent } from '../refine/events.js';
import { reduceRefineEvents } from '../refine/state.js';
import { loadEvents } from '../store/event-store.js';

/**
 * Whether a project is confidential for the chat: marked so in its file, or a refinement of it answered yes or has not
 * answered yet. A record that cannot be read counts as confidential, so a failed check never opens a web search.
 */
export async function isConfidential(input: { cfg: Config; home?: string; dir: string; projectId: string }): Promise<boolean> {
  try {
    const { project } = await readProject(input.dir);
    if (project.confidential) return true;
    const refine = path.posix.join(workspacePaths(input.cfg, input.projectId, input.home).root, 'refine');
    for (const specId of await fs.readdir(refine).catch(() => [] as string[])) {
      const state = reduceRefineEvents((await loadEvents(path.posix.join(refine, specId, 'events.ndjson'))).map(currentEvent));
      if (state.confidential === true || (state.stages === true && state.confidential === undefined)) return true;
    }
    return false;
  } catch {
    return true;
  }
}
