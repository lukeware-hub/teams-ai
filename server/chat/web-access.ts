import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readProject } from '../api/run-index.js';
import type { Config } from '../config/config.js';
import { workspacePaths } from '../orchestrator/workspace.js';
import { currentEvent } from '../refine/events.js';
import { reduceRefineEvents } from '../refine/state.js';
import { loadEvents } from '../store/event-store.js';

/**
 * Whether the chat may search the web about a project: never for a project the owner marked confidential, nor while a
 * refinement of it has not answered that question. A record that cannot be read counts as confidential.
 */
export async function webSearchAllowed(input: { cfg: Config; home?: string; dir: string; projectId: string }): Promise<boolean> {
  try {
    const { project } = await readProject(input.dir);
    if (project.confidential) return false;
    const refine = path.posix.join(workspacePaths(input.cfg, input.projectId, input.home).root, 'refine');
    for (const specId of await fs.readdir(refine).catch(() => [] as string[])) {
      const events = (await loadEvents(path.posix.join(refine, specId, 'events.ndjson'))).map(currentEvent);
      const state = reduceRefineEvents(events);
      if (state.confidential === true || (state.stages === true && state.confidential === undefined)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
