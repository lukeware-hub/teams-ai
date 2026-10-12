import { promises as fs } from 'node:fs';
import path from 'node:path';
import { autoAnswerFloor, precisionNearFloor, routingSamples, type RoutingSample } from '../decide/evals.js';
import { loadEvents } from '../store/event-store.js';

/** The precision the floor must keep overall and right above it before any question is answered on its own. */
const PRECISION = 0.95;

/** The floor a session answers at: a fixed number, nothing when off, or what the project's labelled answers measure. */
export async function answerFloor(setting: number | 'measured' | 'off', refineDir: string): Promise<number | undefined> {
  if (setting === 'off') return undefined;
  if (typeof setting === 'number') return setting;
  const samples: RoutingSample[] = [];
  for (const specId of await fs.readdir(refineDir).catch(() => [] as string[])) {
    samples.push(...routingSamples(await loadEvents(path.join(refineDir, specId, 'events.ndjson')).catch(() => [])));
  }
  const floor = autoAnswerFloor(samples, { precision: PRECISION });
  return floor !== null && (precisionNearFloor(samples, floor) ?? 0) >= PRECISION ? floor : undefined;
}
