import { reduceEvents, type TaskRuntime } from '@server/pipeline/run-state.js';
import type { SecurityFinding, StoredEvent, Usage } from '../api.js';
import { explainBlockReason, firstSentence } from '@server/orchestrator/stop-explain.js';
export {
  blockExplanation, blockedSummary, cascadeBlockers, citedVariables, explainBlockReason, explainPhase, explainStop, firstSentence, groupCauses, lastDeployFailure, liveBlocked, ownHint, phaseTitle, rootBlockers, stopBefore, stopSummary,
} from '@server/orchestrator/stop-explain.js';
export type { BlockExplanation, BlockFinding, DeployFailure, StopExplanation, StopOwner, StopSummary } from '@server/orchestrator/stop-explain.js';

export type { TaskRuntime };
export interface StepRow {
  stepId: string;
  kind: string;
  role: string;
  model: string | null;
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
export interface SecurityRow {
  findings: SecurityFinding[];
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

export type PhaseResult = 'done' | 'failed' | 'running' | 'stopped';
export interface PhaseRow {
  phase: number;
  /** 1 on the first start; a retried phase (a resume, the second verification round) counts up. */
  attempt: number;
  startedAt: string;
  endedAt: string | null;
  result: PhaseResult;
  reason: string | null;
}

const PHASE_STATE: Record<PhaseRow['result'], [label: string, tone: string]> = { done: ['concluída', 'good'], failed: ['falhou', 'bad'], running: ['em execução', 'neutral'], stopped: ['interrompida', ''] };

/** A phase row's chip. The journal alone keeps a paused or dead run's phase running, so the run status refines it. */
export function phaseState(p: PhaseRow, runStatus: string, blockedTasks: number): [label: string, tone: string] {
  if (p.result === 'running' && runStatus.startsWith('paused')) return ['pausada', 'warn'];
  if (p.result === 'running' && runStatus === 'interrupted') return PHASE_STATE.stopped;
  if (p.result === 'done' && p.phase === 3 && blockedTasks > 0) return ['com bloqueios', 'warn'];
  return PHASE_STATE[p.result];
}

/** The RUN_FINISHED that ends the run: one before the last RUN_REOPENED was cancelled by the retry (the server reads it the same way). */
export function finishedEvent(events: StoredEvent[]): StoredEvent | undefined {
  const lastOf = (type: string) => events.map((e) => e.type).lastIndexOf(type);
  const last = lastOf('RUN_FINISHED');
  return last > lastOf('RUN_REOPENED') ? events[last] : undefined;
}

const SUCCESS_RESULTS = new Set(['complete', 'awaiting-validation', 'done']);

/** The round-2 verdict in the server's own wording (phases/verify.ts), plus the ids it names. */
function verificationReason(d: Record<string, unknown>): string {
  const missing = (d.missingDelivery as string[] | undefined) ?? [];
  if (missing.length) return `delivery contract not met on main, missing: ${missing.join(', ')}`;
  const failed = (d.failedTests as string[] | undefined) ?? [];
  const uncovered = (d.uncoveredAcs as string[] | undefined) ?? [];
  return [`verification failed in round 2: ${failed.length} failing tests, ${uncovered.length} uncovered criteria`, failed.length ? `failing: ${failed.join(', ')}` : '', uncovered.length ? `uncovered: ${uncovered.join(', ')}` : ''].filter(Boolean).join('\n');
}

/** One row per phase in the order phases first started; a retried phase keeps its place and shows its latest attempt. */
export function phases(events: StoredEvent[]): PhaseRow[] {
  const rows = new Map<number, PhaseRow>();
  let current: PhaseRow | null = null;
  let deployFailure: string | null = null;
  // Only a running row ends: a later event never turns a failure into a success.
  const end = (row: PhaseRow | null | undefined, at: string, result: PhaseResult, reason: string | null = null) => {
    if (row?.result === 'running') Object.assign(row, { endedAt: at, result, reason });
  };
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case 'PHASE_STARTED': {
        const phase = Number(d.phase);
        // Phases 1-3 journal no success of their own, and Phase 5 gives up without one: another phase starting is the proof it ended.
        if (current && current.phase !== phase) end(current, e.at, current.phase === 5 && deployFailure !== null ? 'failed' : 'done', current.phase === 5 ? deployFailure : null);
        current = { phase, attempt: (rows.get(phase)?.attempt ?? 0) + 1, startedAt: e.at, endedAt: null, result: 'running', reason: null };
        rows.set(phase, current);
        break;
      }
      case 'PHASE_FAILED': {
        const phase = Number(d.phase);
        // The CI workflows (7) fail without ever journaling a start; the failure still gets its row.
        if (!rows.has(phase)) rows.set(phase, { phase, attempt: 1, startedAt: e.at, endedAt: null, result: 'running', reason: null });
        end(rows.get(phase), e.at, 'failed', String(d.reason ?? ''));
        break;
      }
      case 'DOCS_MERGED':
        end(rows.get(Number(d.phase)), e.at, 'done');
        break;
      case 'VERIFICATION_PASSED':
        end(rows.get(4), e.at, 'done');
        break;
      case 'VERIFICATION_FAILED':
        if (Number(d.round) === 2) end(rows.get(4), e.at, 'failed', verificationReason(d));
        break;
      case 'DEPLOY_FAILED':
        deployFailure = String(d.detail ?? '');
        if (Number(d.attempt) >= 3) end(rows.get(5), e.at, 'failed', deployFailure);
        break;
      case 'DEPLOY_VERIFIED':
        deployFailure = null;
        end(rows.get(5), e.at, 'done');
        break;
      case 'REPORT_READY':
        end(rows.get(6), e.at, 'done');
        break;
      case 'RUN_REOPENED': {
        // A retry restarts the blocked tasks, which is the implementation again; the later phases show once they start again.
        for (const phase of [...rows.keys()]) if (phase > 3) rows.delete(phase);
        const implementation = rows.get(3);
        if (implementation) {
          Object.assign(implementation, { endedAt: null, result: 'running', reason: null });
          current = implementation;
        }
        deployFailure = null;
        break;
      }
      case 'RUN_FINISHED': {
        const result = String(d.result);
        if (SUCCESS_RESULTS.has(result)) end(current, e.at, 'done');
        else if (result === 'drained') end(current, e.at, 'stopped');
        else end(current, e.at, 'failed', d.reason ? String(d.reason) : null);
        break;
      }
      default:
        break;
    }
  }
  return [...rows.values()];
}

export function deployOutcome(events: StoredEvent[]) {
  let attempts = 0;
  let verified: { url: string } | null = null;
  let lastFailure: { stage: string; detail: string } | null = null;
  for (const e of events) {
    if (e.type === 'DEPLOY_FAILED') {
      attempts = Math.max(attempts, Number(e.data.attempt));
      lastFailure = { stage: String(e.data.stage), detail: String(e.data.detail ?? '') };
    }
    if (e.type === 'DEPLOY_VERIFIED') {
      attempts = Math.max(attempts, Number(e.data.attempt));
      verified = { url: String(e.data.url) };
      lastFailure = null;
    }
  }
  return { attempts, verified, lastFailure };
}

export function pausedUntil(events: StoredEvent[]): string | null {
  let until: string | null = null;
  for (const e of events) {
    if (e.type === 'RUN_PAUSED') until = e.data.reason === 'quota' ? String(e.data.until ?? '') || null : null;
    if (e.type === 'RUN_RESUMED' || e.type === 'RUN_FINISHED') until = null;
  }
  return until;
}

const startedStep = (d: Record<string, unknown>, tier: string | null = null): StepRow => ({ stepId: String(d.stepId), kind: String(d.kind), role: String(d.role), model: typeof d.model === 'string' ? d.model : null, attempt: Number(d.attempt), ok: null, failure: null, usage: null, durationMs: null, tier });
const finishStep = (s: StepRow, d: Record<string, unknown>) => Object.assign(s, { ok: Boolean(d.ok), failure: (d.failure as string | null) ?? null, usage: d.usage ? add(zero(), d.usage as Usage, (d.costUsd as number | null) ?? null) : null, durationMs: Number(d.durationMs ?? 0) });
/** A task's branch is task/<specId>-<taskId>; runs before readable ids used task/<specId>/<taskId>. */
const isTaskBranch = (branch: string, taskId: string): boolean => branch.startsWith('task/') && (branch.endsWith(`-${taskId}`) || branch.endsWith(`/${taskId}`));

export function taskDetail(events: StoredEvent[], taskId: string) {
  const attempts = new Map<number, { attempt: number; steps: StepRow[]; gates: GateRow[]; review: ReviewRow | null; security: SecurityRow | null }>();
  const at = (n: number) => {
    let a = attempts.get(n);
    if (!a) {
      a = { attempt: n, steps: [], gates: [], review: null, security: null };
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
        at(current).steps.push(startedStep(d, d.kind === 'dev' ? pendingTier : null));
        pendingTier = null;
        break;
      }
      case 'STEP_FINISHED': {
        const s = at(Number(d.attempt)).steps.find((x) => x.stepId === d.stepId);
        if (s) finishStep(s, d);
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
      case 'SECURITY_APPROVED':
      case 'SECURITY_CHANGES':
        at(current).security = { findings: (d.findings as SecurityFinding[] | undefined) ?? [] };
        break;
      case 'MERGE_LOCK_ACQUIRED':
        lockHeld = true;
        break;
      case 'PR_CREATED':
        if (isTaskBranch(String(d.branch), taskId)) pr = { number: Number(d.number), url: String(d.url) };
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

/** How many steps of one agent ran on one model at one effort; effort is null for runs journaled before it was recorded. */
export interface ModelUse { model: string; effort: string | null; steps: number }

export function tokens(events: StoredEvent[]) {
  const byPhase: Record<string, Usage> = {};
  const byRole: Record<string, Usage> = {};
  const modelUses: Record<string, Map<string, ModelUse>> = {};
  let total = zero();
  const started = new Map<string, Record<string, unknown>>();
  const useModel = (role: string, model: string, effort: string | null) => {
    const uses = (modelUses[role] ??= new Map());
    const key = `${model}|${effort ?? ''}`;
    const use = uses.get(key) ?? { model, effort, steps: 0 };
    use.steps += 1;
    uses.set(key, use);
  };
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
      if (s && u) {
        book(e.data.taskId ? 'phase3' : 'phase', String(s.role), u, (e.data.costUsd as number | null) ?? null);
        // The finish carries the model the step ended on (after a fallback); older runs only have the start's.
        const model = String(e.data.model ?? s.model ?? '');
        if (model) useModel(String(s.role), model, (e.data.effort ?? s.effort ?? null) as string | null);
      }
    }
    if (e.type === 'DECISION_MADE') {
      const r = e.data.record as { attempts?: Array<{ backend: string; usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null }> } | undefined;
      // Only a model call costs; a Claude escalation is booked from its own STEP_FINISHED, as the server's accounting does.
      for (const a of r?.attempts ?? []) if (a.backend !== 'claude' && a.usage) book('decide', 'system1', a.usage, a.usage.costUsd);
    }
  }
  const modelsByRole = Object.fromEntries(Object.entries(modelUses).map(([role, uses]) => [role, [...uses.values()].sort((a, b) => b.steps - a.steps)]));
  return { byPhase, byRole, total, modelsByRole };
}

type JunitTest = { id: string; status: string; acIds: string[] };

/** Each criterion's tests with their latest result: the newest verification round on main, else only merged tasks. */
export function evidence(events: StoredEvent[], criteria: string[]) {
  const state = new Map<string, string>();
  const latest = new Map<string, JunitTest & { taskId: string }>();
  const byTask: StoredEvent[] = [];
  let round: unknown = null;
  let closed = false;
  for (const e of events) {
    if (e.type === 'TASK_STATE_CHANGED') state.set(String(e.data.taskId), String(e.data.to));
    if (e.type === 'VERIFICATION_FAILED' || e.type === 'VERIFICATION_PASSED') closed = true;
    if (e.type !== 'GATE_PASSED' && e.type !== 'GATE_FAILED') continue;
    if (e.data.phase !== 4) {
      byTask.push(e);
      continue;
    }
    // A new verification pass, or a new round, replaces the previous results.
    if (closed || e.data.round !== round) latest.clear();
    closed = false;
    round = e.data.round;
    for (const t of (e.data.junit as JunitTest[] | undefined) ?? []) latest.set(t.id, { ...t, taskId: 'main' });
  }
  if (round === null) {
    for (const e of byTask) {
      if (state.get(String(e.data.taskId)) !== 'merged') continue;
      for (const t of (e.data.junit as JunitTest[] | undefined) ?? []) latest.set(t.id, { ...t, taskId: String(e.data.taskId) });
    }
  }
  return criteria.map((acId) => ({ acId, tests: [...latest.values()].filter((t) => t.acIds.includes(acId)).map(({ id, status, taskId }) => ({ id, status, taskId })) }));
}

/** One row per merged task's PR, newest PR number first - for a run overview link list. */
export function mergedPrs(events: StoredEvent[]): Array<{ taskId: string; number: number; url: string }> {
  const branchOf = new Map<string, { number: number; url: string }>();
  for (const e of events) if (e.type === 'PR_CREATED') branchOf.set(String(e.data.branch), { number: Number(e.data.number), url: String(e.data.url) });
  const rows: Array<{ taskId: string; number: number; url: string }> = [];
  for (const e of events) {
    if (e.type !== 'PR_MERGED') continue;
    const taskId = String(e.data.taskId);
    const byBranch = [...branchOf.entries()].find(([b]) => isTaskBranch(b, taskId))?.[1];
    const number = Number(e.data.pr ?? byBranch?.number);
    if (!Number.isFinite(number) || number === 0) continue;
    rows.push({ taskId, number, url: byBranch?.url ?? '' });
  }
  return rows.sort((a, b) => b.number - a.number);
}

export type ActivityTone = 'good' | 'bad' | '';
export interface ActivityItem {
  at: string;
  text: string;
  tone: ActivityTone;
  url: string | null;
  /** A task stopped here; counted as a block, not a problem. */
  block?: true;
}
export interface PhaseActivity {
  items: ActivityItem[];
  steps: StepRow[];
  /** The tasks that blocked in this phase, each in the phase where it blocked last. */
  blockedTaskIds: string[];
}
export interface RunningStep {
  stepId: string;
  kind: string;
  role: string;
  model: string | null;
  taskId: string | null;
  startedAt: string;
}

const STEP_DOING: Record<string, string> = {
  'tech-spec': 'escrevendo a especificação técnica',
  coverage: 'conferindo a cobertura dos critérios de aceite',
  plan: 'montando o plano de tarefas',
  'services-plan': 'montando o plano de tarefas dos serviços',
  dev: 'implementando',
  review: 'revisando o código',
  security: 'revisando a segurança',
  deployment: 'preparando o deploy',
  environment: 'criando o ambiente do teste local',
  report: 'escrevendo o relatório',
  readme: 'escrevendo o README',
  decide: 'tomando uma decisão automática',
  'spec-gap': 'respondendo uma dúvida sobre a spec',
  replan: 'replanejando uma tarefa',
  'fix-tasks': 'criando tarefas de correção',
  architecture: 'decidindo a arquitetura dos repositórios',
};
/** What an agent step kind is doing, in plain words. */
export const stepDoing = (kind: string) => STEP_DOING[kind] ?? kind;

/** "45 s", "2 min 5 s", "1 h 3 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (v: unknown) => (v as string[] | undefined) ?? [];

/** One event as one plain sentence, or null for internal bookkeeping. A confirm reads its own intent's data. */
function describe(e: StoredEvent, intent: Record<string, unknown> | undefined): Omit<ActivityItem, 'at'> | null {
  const d = e.data;
  const item = (text: string, tone: ActivityTone = '', url: unknown = null) => ({ text, tone, url: typeof url === 'string' ? url : null });
  if (e.kind === 'intent') return e.type === 'WORKTREE_CREATE' && e.intentId?.includes(':docs-') ? item(`Branch ${String(d.branch)} preparada a partir da main`) : null;
  if (e.kind === 'confirm') {
    if (e.type === 'DOCS_COMMIT') {
      const files = list(d.files);
      return item(`Commit ${String(d.sha).slice(0, 7)} na branch ${String(intent?.branch)}: ${String(intent?.message)}${files.length ? ` (${count(files.length, 'arquivo', 'arquivos')})` : ''}`);
    }
    if (e.type === 'PR_MERGE' && !d.merged) return item(`Merge do pull request #${String(intent?.number)} recusado: ${String(d.reason ?? '')}`, 'bad');
    return null;
  }
  switch (e.type) {
    case 'PHASE_STARTED':
      return d.round ? item(`Rodada ${String(d.round)} da verificação iniciada`) : null;
    case 'PHASE_FAILED':
      return item(`A fase falhou: ${firstSentence(String(d.reason ?? ''))}`, 'bad');
    case 'REPO_BOOTSTRAPPED':
      return item(`Repositório ${String(d.fullName)} ${d.created ? 'criado' : 'encontrado'} no GitHub`, 'good', d.url);
    case 'PR_CREATED':
      return item(`Pull request #${String(d.number)} ${d.created ? 'aberto' : 'encontrado'} para a branch ${String(d.branch)}`, '', d.url);
    case 'DOCS_MERGED':
      return item(`Documentação mesclada na main${d.pr ? ` pelo pull request #${String(d.pr)}` : ''}`, 'good');
    case 'TECH_SPEC_WRITTEN': {
      const adrs = list(d.adrs);
      return item(`Especificação técnica escrita em ${String(d.path)}${adrs.length ? `, com ${count(adrs.length, 'ADR', 'ADRs')}` : ''}`);
    }
    case 'COVERAGE_CHECKED': {
      const uncovered = list(d.uncovered);
      return uncovered.length ? item(`${count(uncovered.length, 'critério', 'critérios')} de aceite sem cobertura na especificação técnica: ${uncovered.join(', ')}`, 'bad') : item('Todos os critérios de aceite estão cobertos pela especificação técnica', 'good');
    }
    case 'PLAN_CHOSEN':
      return item(`Plano escolhido: opção ${Number(d.index) + 1} de ${String(d.candidates)}`, 'good');
    case 'PREPLAN_DEVIATION':
      return item(`O plano deixou de fora critérios previstos no pré-plano: ${list(d.missingCriteria).join(', ')}`, 'bad');
    case 'FIX_TASKS_PLANNED':
      return item(count(list(d.tasks).length, 'tarefa de correção criada', 'tarefas de correção criadas'));
    case 'GATE_PASSED':
      return item(`Verificação ${String(d.gate)} passou`, 'good');
    case 'GATE_FAILED':
      return item(`Verificação ${String(d.gate)} falhou`, 'bad');
    case 'VERIFICATION_PASSED':
      return item(`Verificação aprovada na rodada ${String(d.round)}`, 'good');
    case 'VERIFICATION_FAILED': {
      const missing = list(d.missingDelivery);
      const detail = missing.length ? `faltam entregas: ${missing.join(', ')}` : `${count(list(d.failedTests).length, 'teste falhando', 'testes falhando')}, ${count(list(d.uncoveredAcs).length, 'critério sem cobertura', 'critérios sem cobertura')}`;
      return item(`Verificação reprovada na rodada ${String(d.round)}: ${detail}`, 'bad');
    }
    case 'DEPLOY_APPLIED':
      return item(`Deploy aplicado${d.service ? ` em ${String(d.service)}` : ''} (tentativa ${String(d.attempt)})`);
    case 'DEPLOY_FAILED':
      return item(`Deploy falhou${d.service ? ` em ${String(d.service)}` : ''} na etapa ${String(d.stage)} (tentativa ${String(d.attempt)}): ${firstSentence(String(d.detail ?? ''))}`, 'bad');
    case 'ROLLBACK_DONE':
      return item(Array.isArray(d.services) ? `Versão anterior restaurada: ${(d.services as string[]).join(', ')}` : 'Versão anterior restaurada');
    case 'DEPLOY_VERIFIED':
      // A services run lists its services; their addresses are the platform's, not the human's.
      return Array.isArray(d.services) ? item(`Deploy verificado: ${(d.services as Array<{ service: string }>).map((s) => s.service).join(', ')}`, 'good') : item(`Deploy verificado em ${String(d.url)}`, 'good', d.url);
    case 'REPORT_READY':
      return item('Relatório final pronto', 'good');
    case 'PR_MERGED':
      return item(`Tarefa ${String(d.taskId)} mesclada na main${d.pr ? ` (pull request #${String(d.pr)})` : ''}`, 'good');
    case 'REBASE_REPLAYED': {
      const files = list(d.files);
      return item(`Tarefa ${String(d.taskId)} movida para a main atual${files.length ? `, com conflitos a resolver em ${files.join(', ')}` : ', sem conflitos a resolver'}`, files.length ? 'bad' : '');
    }
    case 'TASK_BLOCKED':
      return { ...item(`Tarefa ${String(d.taskId)} bloqueada: ${firstSentence(explainBlockReason(String(d.reason ?? '')))}`, 'bad'), block: true };
    case 'SPEC_GAP_ANSWERED':
      return item(`Tarefa ${String(d.taskId)}: os agentes decidiram: ${firstSentence(String(d.answer ?? ''))}`);
    case 'GATE_FIXED':
      return item(`Tarefa ${String(d.taskId)}: comando da verificação ${String(d.gate)} corrigido (${firstSentence(String(d.reason ?? ''), 80)})`);
    case 'GATE_IMAGE_FIXED':
      return item(`Tarefa ${String(d.taskId)}: imagem das verificações trocada de ${String(d.before)} para ${String(d.after)} (${firstSentence(String(d.reason ?? ''), 80)})`);
    case 'RUN_PAUSED':
      return item(d.reason === 'quota' ? `Execução pausada pelo limite de uso dos modelos${d.until ? ` até ${new Date(String(d.until)).toTimeString().slice(0, 5)}` : ''}` : 'Execução pausada: a sessão do Claude expirou', 'bad');
    case 'RUN_RESUMED':
      return item('Execução retomada');
    case 'STEP_FINISHED':
      return d.ok === false ? item(`Etapa ${stepDoing(String(d.kind))} falhou (${String(d.failure)})`, 'bad') : null;
    default:
      return null;
  }
}

/** Reads every event once, keeping each intent so its confirm can be described. */
function describeAll(events: StoredEvent[], visit: (e: StoredEvent, item: ActivityItem | null) => void) {
  const intents = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    if (e.kind === 'intent' && e.intentId) intents.set(e.intentId, e.data);
    const item = describe(e, e.intentId ? intents.get(e.intentId) : undefined);
    visit(e, item ? { at: e.at, ...item } : null);
  }
}

const PHASE_TAG = /^phase(\d+)$/;
/** The task events a phase's timeline still shows: what merged, what blocked and what the agents decided to unblock. */
const PHASE_TASK_EVENTS: ReadonlySet<string> = new Set(['PR_MERGED', 'TASK_BLOCKED', 'REBASE_REPLAYED', 'SPEC_GAP_ANSWERED', 'GATE_FIXED', 'GATE_IMAGE_FIXED']);
const hasTask = (d: Record<string, unknown>) => d.taskId !== null && d.taskId !== undefined && d.taskId !== '';

/**
 * Each phase's timeline and its own agent steps; task steps stay in the task detail.
 * An event that names its phase goes there; any other one belongs to the phase that started last before it.
 */
export function phaseActivity(events: StoredEvent[]): Map<number, PhaseActivity> {
  const out = new Map<number, PhaseActivity>();
  const of = (phase: number) => {
    if (!out.has(phase)) out.set(phase, { items: [], steps: [], blockedTaskIds: [] });
    return out.get(phase)!;
  };
  const stepPhase = new Map<string, number>();
  const blockedIn = new Map<string, number>();
  let current: number | null = null;
  describeAll(events, (e, item) => {
    const d = e.data;
    if (e.type === 'PHASE_STARTED') current = Number(d.phase);
    const tag = typeof d.phase === 'number' ? d.phase : PHASE_TAG.exec(String(d.phase ?? ''))?.[1];
    let phase = tag === undefined ? current : Number(tag);
    if (e.type === 'STEP_STARTED' && phase !== null) stepPhase.set(String(d.stepId), phase);
    if (e.type === 'STEP_FINISHED') phase = stepPhase.get(String(d.stepId)) ?? phase;
    if (phase === null) return;
    const task = hasTask(d);
    if (e.type === 'TASK_BLOCKED') blockedIn.set(String(d.taskId), phase);
    if (e.type === 'STEP_STARTED' && !task) of(phase).steps.push(startedStep(d));
    if (e.type === 'STEP_FINISHED' && !task) {
      const s = of(phase).steps.find((x) => x.stepId === d.stepId);
      if (s) finishStep(s, d);
    }
    if (item && (!task || PHASE_TASK_EVENTS.has(e.type))) of(phase).items.push(item);
  });
  for (const [taskId, phase] of blockedIn) of(phase).blockedTaskIds.push(taskId);
  return out;
}

/** A phase's problems, leaving out the tasks it blocked: those are counted as blocks. */
export const problemItems = (items: ActivityItem[]) => items.filter((i) => i.tone === 'bad' && !i.block);

/** The agent steps running right now, oldest first, and the last thing that happened. */
export function currentActivity(events: StoredEvent[]): { running: RunningStep[]; last: ActivityItem | null } {
  const open = new Map<string, RunningStep>();
  let last: ActivityItem | null = null;
  describeAll(events, (e, item) => {
    const d = e.data;
    if (e.type === 'STEP_STARTED') open.set(String(d.stepId), { stepId: String(d.stepId), kind: String(d.kind), role: String(d.role), model: typeof d.model === 'string' ? d.model : null, taskId: hasTask(d) ? String(d.taskId) : null, startedAt: e.at });
    if (e.type === 'STEP_FINISHED') open.delete(String(d.stepId));
    // A hand resume runs in a new process, so steps open before it are gone.
    if (e.type === 'RUN_RESUMED' && d.manual === true) open.clear();
    if (item) last = item;
  });
  return { running: [...open.values()], last };
}
