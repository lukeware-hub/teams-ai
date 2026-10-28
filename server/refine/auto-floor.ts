import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveDecision, type Config } from '../config/config.js';
import { measuredFloor, routingSamples, type RoutingSample } from '../decide/evals.js';
import { loadEvents } from '../store/event-store.js';
import { currentEvent } from './events.js';

/** The floor a session answers at: a fixed number, nothing when off or routing is off, or what the project's labelled answers prove. */
export async function answerFloor(cfg: Config, refineDir: string): Promise<number | undefined> {
  const setting = cfg.decisions.autoAnswerFloor;
  if (setting === 'off' || !resolveDecision(cfg, 'question-routing').enabled) return undefined;
  if (typeof setting === 'number') return setting;
  const samples: RoutingSample[] = [];
  for (const specId of await fs.readdir(refineDir).catch(() => [] as string[])) {
    samples.push(...routingSamples((await loadEvents(path.join(refineDir, specId, 'events.ndjson')).catch(() => [])).map((e) => currentEvent(e))));
  }
  return measuredFloor(samples) ?? undefined;
}

/** About one question in ten above the floor still goes to the owner, always the same ones, so its labels keep testing the floor. */
export const heldForOwner = (questionId: string): boolean => createHash('sha256').update(questionId).digest()[0]! % 10 === 0;
