import { reduceEvents, type TaskRuntime } from '@server/pipeline/run-state.js';
import type { SecurityFinding, StoredEvent, Usage } from '../api.js';

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

export function phases(events: StoredEvent[]) {
  const out: Array<{ phase: number; startedAt: string; endedAt: string | null; result: 'done' | 'failed' | 'running'; reason: string | null }> = [];
  let deployFailure: string | null = null;
  for (const e of events) {
    if (e.type === 'PHASE_STARTED') {
      // Phase 5 never gets its own end event when the deploy gave up; the next phase starting is the proof.
      const prev = out.at(-1);
      if (prev && prev.phase === 5 && prev.result === 'running' && deployFailure !== null) Object.assign(prev, { endedAt: e.at, result: 'failed', reason: deployFailure });
      out.push({ phase: Number(e.data.phase), startedAt: e.at, endedAt: null, result: 'running', reason: null });
    }
    if (e.type === 'DEPLOY_FAILED') deployFailure = String(e.data.detail ?? '');
    if (e.type === 'DEPLOY_VERIFIED') deployFailure = null;
    const cur = out.at(-1);
    if (!cur) continue;
    if (e.type === 'DOCS_MERGED' && Number(e.data.phase) === cur.phase) Object.assign(cur, { endedAt: e.at, result: 'done' });
    if (e.type === 'PHASE_FAILED' && Number(e.data.phase) === cur.phase) Object.assign(cur, { endedAt: e.at, result: 'failed', reason: String(e.data.reason ?? '') });
    if (e.type === 'VERIFICATION_PASSED' && cur.phase === 4) Object.assign(cur, { endedAt: e.at, result: 'done' });
    if (e.type === 'VERIFICATION_FAILED' && cur.phase === 4 && Number(e.data.round) === 2) Object.assign(cur, { endedAt: e.at, result: 'failed', reason: 'verification failed' });
    if (e.type === 'DEPLOY_VERIFIED' && cur.phase === 5) Object.assign(cur, { endedAt: e.at, result: 'done' });
    if (e.type === 'DEPLOY_FAILED' && cur.phase === 5 && Number(e.data.attempt) >= 3) Object.assign(cur, { endedAt: e.at, result: 'failed', reason: String(e.data.detail ?? '') });
    if (e.type === 'REPORT_READY' && cur.phase === 6) Object.assign(cur, { endedAt: e.at, result: 'done' });
    if (e.type === 'RUN_FINISHED' && cur.result === 'running') Object.assign(cur, { endedAt: e.at, result: ['complete', 'awaiting-validation', 'done'].includes(String(e.data.result)) ? 'done' : 'failed', reason: e.data.reason ? String(e.data.reason) : null });
  }
  return out;
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

export interface DeployFailure {
  attempt: number;
  stage: string;
  detail: string;
  rolledBack: boolean;
  rollbackHealthy: boolean | null;
}

/** The latest deploy failure, or null when nothing failed or a later attempt verified. */
export function lastDeployFailure(events: StoredEvent[]): DeployFailure | null {
  let out: DeployFailure | null = null;
  for (const e of events) {
    if (e.type === 'DEPLOY_FAILED') out = { attempt: Number(e.data.attempt), stage: String(e.data.stage), detail: String(e.data.detail ?? ''), rolledBack: e.data.rolledBack === true, rollbackHealthy: typeof e.data.rollbackHealthy === 'boolean' ? e.data.rollbackHealthy : null };
    if (e.type === 'DEPLOY_VERIFIED') out = null;
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
      case 'SECURITY_APPROVED':
      case 'SECURITY_CHANGES':
        at(current).security = { findings: (d.findings as SecurityFinding[] | undefined) ?? [] };
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

export type StopOwner = 'Sistema' | 'Plano' | 'Você';
export interface StopExplanation {
  title: string;
  hint: string;
  owner: StopOwner;
}

// First match wins. Reasons are the orchestrator's English strings (server/orchestrator/task-runner.ts, phases/deploy.ts).
const STOP_RULES: Array<[RegExp, StopExplanation]> = [
  [/plan\.commands\.smoke missing/, { title: 'O plano não define commands.smoke', hint: 'Falta o comando dos testes de fumaça no plan.json. Nenhum agente edita o plano durante a run: adicione commands.smoke ao plano na main e tente de novo.', owner: 'Plano' }],
  [/produced no changes against origin\/main/, { title: 'O Dev disse que terminou, mas não alterou nada', hint: 'A tarefa não gerou diferença em relação à main. Costuma ser um problema que código não resolve (ex.: um campo faltando no plano); repetir a tarefa só gasta tokens.', owner: 'Sistema' }],
  [/^Scope violation:/, { title: 'O Dev mexeu em arquivos fora do escopo da tarefa', hint: 'A mudança foi rejeitada antes do merge. Revise os caminhos permitidos da tarefa no plano.', owner: 'Sistema' }],
  [/^spec-gap rounds exhausted/, { title: 'O Dev continuou com dúvidas sobre a spec', hint: 'O Scrum Master respondeu três vezes e a dúvida persiste. Esclareça o ponto na spec e inicie uma nova execução.', owner: 'Você' }],
  [/^Security review requested changes/, { title: 'A revisão de segurança pediu mudanças', hint: 'Os ajustes não passaram depois de todas as tentativas. Veja os achados na tarefa.', owner: 'Sistema' }],
  [/^Review requested changes/, { title: 'A revisão de código pediu mudanças', hint: 'Os ajustes não passaram depois de todas as tentativas. Veja os achados na tarefa.', owner: 'Sistema' }],
  [/^Review evidence rejected/, { title: 'A evidência da revisão foi rejeitada', hint: 'O revisor não apresentou evidência válida. Abra a tarefa para ver o motivo.', owner: 'Sistema' }],
  [/^Rebase conflicts/, { title: 'Conflito de rebase com a main', hint: 'Outra tarefa alterou os mesmos arquivos e o conflito não foi resolvido automaticamente.', owner: 'Sistema' }],
  [/^Merge (refused|queue)/, { title: 'O merge foi recusado', hint: 'O GitHub ou a fila de merge recusou a mudança várias vezes. Confira permissões e proteção de branch do repositório.', owner: 'Você' }],
  [/^Task token budget exceeded/, { title: 'A tarefa estourou o orçamento de tokens', hint: 'Divida a tarefa em partes menores no plano ou aumente o limite por tarefa.', owner: 'Sistema' }],
  [/^replan (rejected|failed)/, { title: 'O replanejamento da tarefa falhou', hint: 'O Scrum Master não conseguiu dividir a tarefa. Veja o detalhe técnico.', owner: 'Sistema' }],
];

/** A pt-BR explanation of a raw stop reason, or null when it is not one the UI knows (callers then show it raw). */
export function explainStop(reason: string): StopExplanation | null {
  return STOP_RULES.find(([re]) => re.test(reason))?.[1] ?? null;
}

const STOP_STATUSES = new Set(['deploy-failed', 'verification-failed', 'blocked', 'phase-failed', 'deadlocked']);

export interface StopSummary {
  what: string;
  title: string;
  hint: string;
  owner: StopOwner;
  raw: string;
  rollback: string | null;
  action: 'redeploy' | null;
}

/** What the outcome banner says about a run that ended without success, or null while it is fine. */
export function stopSummary(input: { status: string; reason: string | null; causes: Array<{ taskId: string; reason: string }>; deployFailure: DeployFailure | null }): StopSummary | null {
  const { status, reason, causes, deployFailure } = input;
  if (!STOP_STATUSES.has(status)) return null;
  if (status === 'deploy-failed') {
    const f = deployFailure;
    const raw = f ? f.detail : (reason ?? '');
    const generic: StopExplanation = { title: f ? `Falha no estágio ${f.stage}` : 'O deploy falhou', hint: 'O orquestrador esgotou as tentativas de deploy. Veja o detalhe técnico e os logs do container.', owner: 'Sistema' };
    const why = explainStop(raw) ?? explainStop(reason ?? '') ?? generic;
    const rollback = f?.rolledBack ? (f.rollbackHealthy === false ? 'Rollback feito, mas a versão anterior não respondeu ao healthcheck.' : 'Rollback feito e saudável: a versão anterior continua no ar.') : null;
    return { what: f ? `O deploy falhou no estágio ${f.stage} (tentativa ${f.attempt}).` : 'O deploy falhou.', ...why, raw, rollback, action: 'redeploy' };
  }
  if (status === 'verification-failed') {
    return { what: 'A verificação (fase 4) não passou depois de duas rodadas.', title: 'Os testes de aceitação não passaram', hint: 'Veja a matriz de evidências abaixo e reporte o problema na tela de validação.', owner: 'Sistema', raw: reason ?? '', rollback: null, action: null };
  }
  if (status === 'deadlocked') {
    return { what: 'Nenhuma tarefa pode avançar.', title: 'Todas as tarefas restantes dependem de uma tarefa bloqueada', hint: 'Corrija a tarefa bloqueada primeiro (veja "Por que parou").', owner: 'Você', raw: reason ?? '', rollback: null, action: null };
  }
  if (status === 'phase-failed') {
    const why = explainStop(reason ?? '');
    return { what: 'Uma fase da run falhou.', title: why?.title ?? 'Falha na fase', hint: why?.hint ?? 'Veja o detalhe técnico.', owner: why?.owner ?? 'Sistema', raw: reason ?? '', rollback: null, action: null };
  }
  const first = causes[0];
  const why = (first ? explainStop(first.reason) : null) ?? { title: first ? 'Tarefa bloqueada' : 'Tarefas bloqueadas', hint: 'Abra a tarefa para ver o motivo.', owner: 'Sistema' as StopOwner };
  const n = causes.length;
  return { what: n === 1 ? '1 tarefa ficou bloqueada.' : `${n} tarefas ficaram bloqueadas.`, ...why, raw: first?.reason ?? reason ?? '', rollback: null, action: null };
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
