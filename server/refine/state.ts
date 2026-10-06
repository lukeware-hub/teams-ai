import type { Backlog, BacklogItem } from '../contracts/backlog.js';
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { ChecklistItem } from './checklist.js';
import { RefineEvent, type Question } from './events.js';
import type { PendingPatch } from './patches.js';

export type RefineStatus = 'drafting' | 'evaluating' | 'answering' | 'ready' | 'error' | 'started';
export interface QuestionRow extends Question {
  status: 'pending' | 'answered' | 'skipped';
  answer: string | null;
}
export interface PatchRow extends PendingPatch {
  cycle: number;
  status: 'pending' | 'accepted' | 'rejected' | 'dropped';
  decision: string | null;
}
/** Backlog mode: the docs broken into epics and ranked items (browser-safe, shared with the web reducer). */
export interface BacklogState {
  enabled: boolean;
  project: Project | null;
  epics: Backlog['epics'];
  items: Array<BacklogItem & { rank: number }>;
  cycle: number;
}

export interface RefineState {
  status: RefineStatus;
  stale: boolean;
  cycle: number;
  derived: { project: Project; spec: Spec } | null;
  checklist: ChecklistItem[];
  questions: QuestionRow[];
  patches: PatchRow[];
  discarded: Array<{ cycle: number; role: string; file: string; reason: string }>;
  error: string | null;
  runId: string | null;
  backlog: BacklogState | null;
}

export const emptyRefineState = (): RefineState => ({
  status: 'drafting',
  stale: false,
  cycle: 0,
  derived: null,
  checklist: [],
  questions: [],
  patches: [],
  discarded: [],
  error: null,
  runId: null,
  backlog: null,
});

const STICKY: ReadonlySet<RefineStatus> = new Set(['evaluating', 'error', 'started']);

/** Spec (refinement) §3.1: ready = all green, no pending patch, no pending blocking question. */
export function computeStatus(s: RefineState): RefineStatus {
  if (STICKY.has(s.status)) return s.status;
  const pendingBlocking = s.questions.some((q) => q.status === 'pending' && q.blocking);
  const pendingPatch = s.patches.some((p) => p.status === 'pending');
  const pendingAny = pendingPatch || s.questions.some((q) => q.status === 'pending');
  const green = s.checklist.length > 0 && s.checklist.every((i) => i.passed);
  if (green && !pendingBlocking && !pendingPatch) return 'ready';
  return pendingAny ? 'answering' : 'drafting';
}

export function applyRefineEvent(s: RefineState, e: { type: string; data: Record<string, unknown> }): void {
  const d = e.data;
  switch (e.type) {
    case RefineEvent.CycleStarted:
      s.cycle = Number(d.cycle);
      s.status = 'evaluating';
      s.error = null;
      break;
    case RefineEvent.Derived:
      s.derived = { project: d.project as Project, spec: d.spec as Spec };
      break;
    case RefineEvent.PatchProposed:
      s.patches.push({ ...(d as unknown as PendingPatch & { cycle: number }), status: 'pending', decision: null });
      break;
    case RefineEvent.Evaluated: {
      const v = d as unknown as { cycle: number; checklist: ChecklistItem[]; questions: Question[]; discardedPatches: Array<{ role: string; file: string; reason: string }> };
      s.checklist = v.checklist;
      s.questions.push(...v.questions.map((q) => ({ ...q, status: 'pending' as const, answer: null })));
      s.discarded.push(...v.discardedPatches.map((x) => ({ cycle: v.cycle, ...x })));
      s.stale = false;
      s.status = 'drafting';
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.CycleFailed:
      s.error = String(d.reason);
      s.status = 'error';
      break;
    case RefineEvent.PatchAccepted:
    case RefineEvent.PatchRejected:
    case RefineEvent.PatchDropped: {
      const p = s.patches.find((x) => x.patchId === String(d.patchId));
      if (p) {
        p.status = e.type === RefineEvent.PatchAccepted ? 'accepted' : e.type === RefineEvent.PatchRejected ? 'rejected' : 'dropped';
        p.decision = (d.reason as string | null | undefined) ?? null;
      }
      if (e.type === RefineEvent.PatchAccepted && s.derived) s.stale = true;
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.QuestionAnswered:
    case RefineEvent.QuestionSkipped: {
      const q = s.questions.find((x) => x.questionId === String(d.questionId));
      if (q) {
        q.status = e.type === RefineEvent.QuestionAnswered ? 'answered' : 'skipped';
        q.answer = (d.text as string | undefined) ?? null;
      }
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.DocEdited:
    case RefineEvent.SecretWritten:
      if (s.derived) s.stale = true;
      break;
    case RefineEvent.BacklogEnabled:
      s.backlog = s.backlog ? { ...s.backlog, enabled: true } : { enabled: true, project: null, epics: [], items: [], cycle: 0 };
      if (s.derived || s.checklist.length > 0) s.stale = true;
      break;
    case RefineEvent.BacklogDerived:
      s.backlog = { enabled: true, project: d.project as Project, epics: d.epics as BacklogState['epics'], items: d.items as BacklogState['items'], cycle: Number(d.cycle) };
      break;
    case RefineEvent.StartedRun:
      s.status = 'started';
      s.runId = String(d.runId);
      break;
    default:
      break;
  }
}

export function reduceRefineEvents(events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): RefineState {
  const s = emptyRefineState();
  for (const e of events) applyRefineEvent(s, e);
  return s;
}
