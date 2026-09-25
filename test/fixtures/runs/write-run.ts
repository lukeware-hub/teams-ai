import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface FixtureEvent {
  type: string;
  data?: Record<string, unknown>;
  kind?: 'fact' | 'intent' | 'confirm';
  intentId?: string;
}

const HASH = 'sha256:' + 'a'.repeat(64);

export function eventLines(runId: string, events: FixtureEvent[], startSeq = 1, at = '2026-09-24T10:00:00.000Z'): string {
  return events
    .map((e, i) => JSON.stringify({ seq: startSeq + i, at, runId, specHash: HASH, type: e.type, kind: e.kind ?? 'fact', ...(e.intentId ? { intentId: e.intentId } : {}), data: e.data ?? {} }))
    .join('\n');
}

export async function writeRun(runsDir: string, runId: string, events: FixtureEvent[], state: Record<string, unknown> | null = null, pid?: number): Promise<string> {
  const dir = path.join(runsDir, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'events.ndjson'), events.length ? `${eventLines(runId, events)}\n` : '');
  if (state) await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  if (pid !== undefined) await fs.writeFile(path.join(dir, 'pid'), String(pid));
  return dir;
}

export async function appendEvents(runsDir: string, runId: string, events: FixtureEvent[], startSeq: number): Promise<void> {
  await fs.appendFile(path.join(runsDir, runId, 'events.ndjson'), `${eventLines(runId, events, startSeq)}\n`);
}
