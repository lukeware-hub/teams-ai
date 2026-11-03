import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface JournalEvent {
  type: string;
  at?: string;
  data: Record<string, unknown>;
}

export interface RefineMetrics {
  /** The reviews of each document: how many, how many were replayed without an agent call, and the seconds each took. */
  reviews: Record<string, { count: number; replayed: number; seconds: number[] }>;
  /** The agent calls by role, with their tokens and cost. */
  agents: Record<string, { calls: number; tokens: number; costUsd: number }>;
  /** What the owner did by hand, and what the agents did alone. */
  owner: { answers: number; skips: number; acceptedByOwner: number; rejected: number; stagesContinued: number };
  agentsAlone: { acceptedPatches: number };
}

const seconds = (from: string | undefined, to: string | undefined): number | null => {
  const ms = Date.parse(to ?? '') - Date.parse(from ?? '');
  return Number.isNaN(ms) ? null : ms / 1000;
};

/** The numbers that tell whether a refinement got faster, cheaper and less dependent on the owner, read from its journal. */
export function refineMetrics(events: readonly JournalEvent[]): RefineMetrics {
  const out: RefineMetrics = { reviews: {}, agents: {}, owner: { answers: 0, skips: 0, acceptedByOwner: 0, rejected: 0, stagesContinued: 0 }, agentsAlone: { acceptedPatches: 0 } };
  let cycleStart: string | undefined;
  const roleOfStep = new Map<string, string>();
  for (const e of events) {
    switch (e.type) {
      case 'REFINE_CYCLE_STARTED':
        cycleStart = e.at;
        break;
      case 'REFINE_STAGE_REVIEWED': {
        const file = String(e.data.file);
        const row = (out.reviews[file] ??= { count: 0, replayed: 0, seconds: [] });
        row.count += 1;
        if (e.data.replayed === true) row.replayed += 1;
        const took = seconds(cycleStart, e.at);
        if (took !== null) row.seconds.push(took);
        break;
      }
      case 'STEP_STARTED':
        roleOfStep.set(String(e.data.stepId), String(e.data.role));
        break;
      case 'STEP_FINISHED': {
        const role = roleOfStep.get(String(e.data.stepId)) ?? 'unknown';
        const row = (out.agents[role] ??= { calls: 0, tokens: 0, costUsd: 0 });
        const usage = (e.data.usage ?? {}) as { inputTokens?: number; outputTokens?: number };
        row.calls += 1;
        row.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        row.costUsd += Number(e.data.costUsd ?? 0);
        break;
      }
      case 'QUESTION_ANSWERED':
        out.owner.answers += 1;
        break;
      case 'QUESTION_SKIPPED':
        out.owner.skips += 1;
        break;
      case 'PATCH_ACCEPTED':
        if (e.data.auto === true) out.agentsAlone.acceptedPatches += 1;
        else out.owner.acceptedByOwner += 1;
        break;
      case 'PATCH_REJECTED':
        out.owner.rejected += 1;
        break;
      case 'REFINE_STAGE_ADVANCED':
        out.owner.stagesContinued += 1;
        break;
    }
  }
  return out;
}

/** Prints the metrics of a draft's journal (events.ndjson). */
async function main(file: string): Promise<void> {
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  console.log(JSON.stringify(refineMetrics(lines.map((l) => JSON.parse(l) as JournalEvent)), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('usage: tsx scripts/refine-metrics.ts <path to events.ndjson>');
  await main(process.argv[2]);
}
