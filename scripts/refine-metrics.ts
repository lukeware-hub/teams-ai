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

/** The targets of the autonomy program for one project, from "Success metrics per project" in the autonomous refinement design. */
export const AUTONOMY_TARGETS = { ownerActions: 110, idleHours: 6, solvedAloneShare: 0.95, pauses: 1 } as const;

/** Events that only an owner's click writes; an answer by a role and a suggestion the agents took are told apart by their data. */
const OWNER_EVENTS = new Set([
  'REFINE_CREATED', 'REFINE_CONFIDENTIALITY_ANSWERED', 'QUESTION_SKIPPED', 'QUESTION_REASKED', 'PATCH_REJECTED',
  'REFINE_STAGE_ADVANCED', 'REFINE_STAGE_REPROCESSED', 'REFINE_REVIEW_CLOSED', 'DOC_MOVE_UNDONE', 'DOC_RESHAPE_UNDONE',
  'REFINE_NOTICE_CLOSED', 'SPECKIT_ANSWERS_STARTED', 'BACKLOG_ENABLED', 'BACKLOG_DETAIL_ENABLED', 'REFINE_SPECS_OWNER_APPROVED',
  'REFINE_DEVELOPMENT_AUTHORIZED', 'REFINE_STARTED_RUN',
]);
const FAILURES = new Set(['REFINE_CYCLE_FAILED', 'PLANS_FAILED', 'REFINE_ARCHITECTURE_FAILED', 'REFINE_DOC_GRAPH_FAILED']);
const RESUMES = new Set(['REFINE_CYCLE_STARTED', 'PLANS_STARTED', 'REFINE_ARCHITECTURE_STARTED', 'REFINE_DOC_GRAPH_STARTED']);
/** Owner events closer than this to the previous one come from the same click, such as "accept all". */
const SAME_CLICK_MS = 1000;
const HOUR_MS = 3_600_000;

const isOwnerEvent = (e: JournalEvent): boolean =>
  e.type === 'QUESTION_ANSWERED' ? e.data.by === undefined : e.type === 'PATCH_ACCEPTED' ? e.data.auto !== true : OWNER_EVENTS.has(e.type);

/** The total length of time intervals that may overlap. */
function unionMs(intervals: Array<[number, number]>): number {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of intervals.sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

export interface AutonomyMetrics {
  /** The owner's clicks, and the events they wrote. A start after a failure outside the team's own work counts as the owner's retry. */
  ownerActions: { value: number; events: number; target: number; met: boolean };
  /** Hours in which no agent, graph extraction or quota wait was running, and how many of them came after a failure. */
  idleHours: { value: number; afterFailure: number; target: number; met: boolean };
  /** The failures, and those the team resumed on its own; the journal does not mark the heal driver's retries yet. */
  failures: { total: number; solvedAlone: number; share: number; target: number; met: boolean };
  pauses: { value: number; target: number; met: boolean };
}

/** The autonomy targets measured on a draft's journal: how much the owner did, how long the work stood still, and how failures ended. */
export function autonomyMetrics(events: readonly JournalEvent[]): AutonomyMetrics {
  const busy: Array<[number, number]> = [];
  const openSteps = new Map<string, number>();
  let graphStart: number | null = null;
  let teamAlone = false;
  let lastOwner = -Infinity;
  let clicks = 0;
  let ownerEvents = 0;
  let failures = 0;
  let solvedAlone = 0;
  let pauses = 0;
  let waiting = 0;
  let failedAt: number | null = null;
  let afterFailureMs = 0;
  let first = Infinity;
  let last = -Infinity;
  const owner = (at: number): void => {
    ownerEvents += 1;
    if (at - lastOwner >= SAME_CLICK_MS) clicks += 1;
    lastOwner = at;
  };
  for (const e of events) {
    const at = Date.parse(e.at ?? '');
    if (Number.isNaN(at)) continue;
    first = Math.min(first, at);
    last = Math.max(last, at);
    if (e.type === 'TEAM_AUTOPILOT_STARTED') teamAlone = true;
    else if (e.type === 'TEAM_AUTOPILOT_STOPPED') teamAlone = false;
    else if (e.type === 'STEP_STARTED') openSteps.set(String(e.data.stepId), at);
    else if (e.type === 'STEP_FINISHED') {
      const from = openSteps.get(String(e.data.stepId));
      if (from !== undefined) busy.push([from, at]);
      openSteps.delete(String(e.data.stepId));
    } else if (e.type === 'REFINE_DOC_GRAPH_STARTED') graphStart = at;
    else if ((e.type === 'REFINE_DOC_GRAPHED' || e.type === 'REFINE_DOC_GRAPH_FAILED') && graphStart !== null) {
      busy.push([graphStart, at]);
      graphStart = null;
    } else if (e.type === 'REFINE_QUOTA_WAITING') {
      const until = Date.parse(String(e.data.until));
      if (!Number.isNaN(until)) busy.push([at, until]);
    } else if (e.type === 'AUTOPILOT_PAUSED') pauses += 1;
    if (FAILURES.has(e.type)) {
      failures += 1;
      waiting += 1;
      failedAt ??= at;
    } else if (RESUMES.has(e.type) && failedAt !== null) {
      // One start resumes every failure that waited for it.
      if (teamAlone) solvedAlone += waiting;
      else owner(at);
      afterFailureMs += at - failedAt;
      waiting = 0;
      failedAt = null;
    }
    if (!teamAlone && isOwnerEvent(e)) owner(at);
  }
  // Work still running at the end of the journal counts as busy up to its last event.
  for (const from of [...openSteps.values(), ...(graphStart === null ? [] : [graphStart])]) busy.push([from, last]);
  if (failedAt !== null) afterFailureMs += last - failedAt;
  const idle = first === Infinity ? 0 : Math.max(0, last - first - unionMs(busy.map(([from, to]) => [Math.max(from, first), Math.min(to, last)])));
  const share = failures === 0 ? 1 : solvedAlone / failures;
  const t = AUTONOMY_TARGETS;
  return {
    ownerActions: { value: clicks, events: ownerEvents, target: t.ownerActions, met: clicks <= t.ownerActions },
    idleHours: { value: idle / HOUR_MS, afterFailure: afterFailureMs / HOUR_MS, target: t.idleHours, met: idle / HOUR_MS <= t.idleHours },
    failures: { total: failures, solvedAlone, share, target: t.solvedAloneShare, met: share >= t.solvedAloneShare },
    pauses: { value: pauses, target: t.pauses, met: pauses <= t.pauses },
  };
}

/** Prints the metrics of a draft's journal (events.ndjson), with the autonomy targets. */
async function main(file: string): Promise<void> {
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  const events = lines.map((l) => JSON.parse(l) as JournalEvent);
  console.log(JSON.stringify({ ...refineMetrics(events), autonomy: autonomyMetrics(events) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('usage: tsx scripts/refine-metrics.ts <path to events.ndjson>');
  await main(process.argv[2]);
}
