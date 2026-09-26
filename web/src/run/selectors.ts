import { reduceEvents, type TaskRuntime } from '@server/pipeline/run-state.js';
import type { StoredEvent, Usage } from '../api.js';

export type { TaskRuntime };
export interface StepRow {
  stepId: string;
  kind: string;
  role: string;
  attempt: number;
  ok: boolean | null;
  failure: string | null;
  usage: Usage | null;
  durationMs: number | null;
  tier: string | null;
}
export interface GateRow {
  attempt: number;
  gate: string;
  passed: boolean;
  failedTests: string[];
}
export interface ReviewRow {
  profile: string;
  risk: string;
  drift: string | null;
  findings: unknown[];
}

const zero = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 });
const add = (a: Usage, u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }, cost: number | null): Usage => ({
  inputTokens: a.inputTokens + u.inputTokens,
  outputTokens: a.outputTokens + u.outputTokens,
  cacheReadTokens: a.cacheReadTokens + (u.cacheReadTokens ?? 0),
  cacheWriteTokens: a.cacheWriteTokens + (u.cacheWriteTokens ?? 0),
  costUsd: Math.round((a.costUsd + (cost ?? 0)) * 1e8) / 1e8,
  steps: a.steps + 1,
});

export function runState(events: StoredEvent[]) {
  return reduceEvents(events);
}

export function phases(events: StoredEvent[]) {
  const out: Array<{ phase: number; startedAt: string; endedAt: string | null; result: 'done' | 'failed' | 'running'; reason: string | null }> = [];
  for (const e of events) {
    if (e.type === 'PHASE_STARTED') out.push({ phase: Number(e.data.phase), startedAt: e.at, endedAt: null, result: 'running', reason: null });
    const cur = out.at(-1);
    if (!cur) continue;
    if (e.type === 'DOCS_MERGED' && Number(e.data.phase) === cur.phase) Object.assign(cur, { endedAt: e.at, result: 'done' });
    if (e.type === 'PHASE_FAILED' && Number(e.data.phase) === cur.phase) Object.assign(cur, { endedAt: e.at, result: 'failed', reason: String(e.data.reason ?? '') });
    if (e.type === 'RUN_FINISHED' && cur.result === 'running') Object.assign(cur, { endedAt: e.at, result: e.data.result === 'complete' ? 'done' : 'failed', reason: e.data.reason ? String(e.data.reason) : null });
  }
  return out;
}

export function pausedUntil(events: StoredEvent[]): string | null {
  let until: string | null = null;
  for (const e of events) {
    if (e.type === 'RUN_PAUSED') until = e.data.reason === 'quota' ? String(e.data.until ?? '') || null : null;
    if (e.type === 'RUN_RESUMED' || e.type === 'RUN_FINISHED') until = null;
  }
  return until;
}

export function taskDetail(events: StoredEvent[], taskId: string) {
  const attempts = new Map<number, { attempt: number; steps: StepRow[]; gates: GateRow[]; review: ReviewRow | null }>();
  const at = (n: number) => {
    let a = attempts.get(n);
    if (!a) {
      a = { attempt: n, steps: [], gates: [], review: null };
      attempts.set(n, a);
    }
    return a;
  };
  let pr: { number: number; url: string } | null = null;
  let merged = false;
  let blockedReason: string | null = null;
  let lockHeld = false;
  let current = 0;
  let pendingTier: string | null = null;
  let pendingReview: Partial<ReviewRow> = {};
  for (const e of events) {
    const d = e.data;
    if (d.taskId !== taskId && e.type !== 'DECISION_MADE' && e.type !== 'PR_CREATED') continue;
    switch (e.type) {
      case 'DECISION_MADE': {
        const r = d.record as { decisionId?: string; answers?: Record<string, { value?: unknown }> } | undefined;
        if (r?.decisionId === 'model-tier') pendingTier = String(r.answers?.tier?.value ?? '') || null;
        break;
      }
      case 'STEP_STARTED': {
        current = Number(d.attempt);
        at(current).steps.push({ stepId: String(d.stepId), kind: String(d.kind), role: String(d.role), attempt: current, ok: null, failure: null, usage: null, durationMs: null, tier: d.kind === 'dev' ? pendingTier : null });
        pendingTier = null;
        break;
      }
      case 'STEP_FINISHED': {
        const s = at(Number(d.attempt)).steps.find((x) => x.stepId === d.stepId);
        if (s) Object.assign(s, { ok: Boolean(d.ok), failure: (d.failure as string | null) ?? null, usage: d.usage ? add(zero(), d.usage as Usage, (d.costUsd as number | null) ?? null) : null, durationMs: Number(d.durationMs ?? 0) });
        break;
      }
      case 'GATE_PASSED':
      case 'GATE_FAILED': {
        const junit = (d.junit as Array<{ id: string; status: string }> | undefined) ?? [];
        at(current).gates.push({ attempt: current, gate: String(d.gate), passed: e.type === 'GATE_PASSED', failedTests: junit.filter((t) => t.status === 'failed').map((t) => t.id) });
        break;
      }
      case 'SCOPE_DRIFT_SCORED':
        pendingReview.drift = String(d.drift);
        break;
      case 'REVIEW_PROFILE_CHOSEN':
        pendingReview = { ...pendingReview, profile: String(d.profile), risk: String(d.risk) };
        break;
      case 'REVIEW_APPROVED':
      case 'REVIEW_CHANGES':
        at(current).review = { profile: pendingReview.profile ?? 'standard', risk: pendingReview.risk ?? 'medium', drift: pendingReview.drift ?? null, findings: (d.findings as unknown[] | undefined) ?? [] };
        pendingReview = {};
        break;
      case 'MERGE_LOCK_ACQUIRED':
        lockHeld = true;
        break;
      case 'PR_CREATED':
        if (String(d.branch).endsWith(`/${taskId}`)) pr = { number: Number(d.number), url: String(d.url) };
        break;
      case 'PR_MERGED':
        merged = true;
        lockHeld = false;
        break;
      case 'TASK_BLOCKED':
        blockedReason = String(d.reason);
        break;
      default:
        break;
    }
  }
  return { attempts: [...attempts.values()].sort((a, b) => a.attempt - b.attempt), pr, merged, blockedReason, lockHeld };
}

export function tokens(events: StoredEvent[]) {
  const byPhase: Record<string, Usage> = {};
  const byRole: Record<string, Usage> = {};
  let total = zero();
  const started = new Map<string, Record<string, unknown>>();
  const book = (phase: string, role: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }, cost: number | null) => {
    byPhase[phase] = add(byPhase[phase] ?? zero(), u, cost);
    byRole[role] = add(byRole[role] ?? zero(), u, cost);
    total = add(total, u, cost);
  };
  for (const e of events) {
    if (e.type === 'STEP_STARTED') started.set(String(e.data.stepId), e.data);
    if (e.type === 'STEP_FINISHED') {
      const s = started.get(String(e.data.stepId));
      const u = e.data.usage as Usage | undefined;
      if (s && u) book(e.data.taskId ? 'phase3' : 'phase', String(s.role), u, (e.data.costUsd as number | null) ?? null);
    }
    if (e.type === 'DECISION_MADE') {
      const r = e.data.record as { usage?: { inputTokens: number; outputTokens: number; costUsd: number | null } } | undefined;
      if (r?.usage) book('decide', 'system1', r.usage, r.usage.costUsd);
    }
  }
  return { byPhase, byRole, total };
}

export function evidence(events: StoredEvent[], criteria: string[]) {
  // latest gate round per task and gate: the same test id from a later event replaces the earlier one
  const latest = new Map<string, Map<string, { id: string; status: string; acIds: string[] }>>();
  for (const e of events) {
    if (e.type !== 'GATE_PASSED' && e.type !== 'GATE_FAILED') continue;
    const key = `${String(e.data.taskId)}::${String(e.data.gate)}`;
    const tests = new Map<string, { id: string; status: string; acIds: string[] }>();
    for (const t of (e.data.junit as Array<{ id: string; status: string; acIds: string[] }> | undefined) ?? []) tests.set(t.id, t);
    latest.set(key, tests);
  }
  return criteria.map((acId) => {
    const tests: Array<{ id: string; status: string; taskId: string }> = [];
    const seen = new Set<string>();
    for (const [key, byId] of latest) {
      for (const t of byId.values()) {
        if (t.acIds.includes(acId) && !seen.has(t.id)) {
          seen.add(t.id);
          tests.push({ id: t.id, status: t.status, taskId: key.split('::')[0]! });
        }
      }
    }
    return { acId, tests };
  });
}

/** Task-block reasons come straight from the orchestrator in English; translate the ones a user needs
 * to actually read (a plain dependency cascade isn't worth surfacing on its own — see rootBlockers). */
export function explainBlockReason(reason: string): string {
  const scope = reason.match(/^Scope violation:\n([\s\S]*)$/);
  if (scope) return `Violação de escopo: ${scope[1]!.replace(/^frozen files modified: /, 'arquivos protegidos foram alterados: ')}`;
  if (reason === 'a dependency is blocked') return 'uma dependência desta tarefa está bloqueada';
  return reason;
}

/** The tasks whose block has its own real cause, filtering out the ones that are only blocked because
 * something upstream failed (a pure dependency cascade, with no diagnostic value of its own). */
export function rootBlockers(blocked: Array<{ taskId: string; reason: string }>): Array<{ taskId: string; reason: string }> {
  return blocked.filter((b) => b.reason !== 'a dependency is blocked');
}

/** One row per merged task's PR, in the order the merge happened - for a run overview link list. */
export function mergedPrs(events: StoredEvent[]): Array<{ taskId: string; number: number; url: string }> {
  const branchOf = new Map<string, { number: number; url: string }>();
  for (const e of events) if (e.type === 'PR_CREATED') branchOf.set(String(e.data.branch), { number: Number(e.data.number), url: String(e.data.url) });
  const rows: Array<{ taskId: string; number: number; url: string }> = [];
  for (const e of events) {
    if (e.type !== 'PR_MERGED') continue;
    const taskId = String(e.data.taskId);
    const byBranch = [...branchOf.entries()].find(([b]) => b.endsWith(`/${taskId}`))?.[1];
    const number = Number(e.data.pr ?? byBranch?.number);
    if (!Number.isFinite(number)) continue;
    rows.push({ taskId, number, url: byBranch?.url ?? '' });
  }
  return rows;
}
