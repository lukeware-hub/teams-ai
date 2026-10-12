import { reduceEvents, type TaskRuntime } from '@server/pipeline/run-state.js';
import type { SecurityFinding, StoredEvent, Usage } from '../api.js';

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

const PHASE_NAMES: Record<number, string> = { 0: 'Preparação do repositório', 1: 'Especificação técnica', 2: 'Plano', 3: 'Implementação', 4: 'Verificação', 5: 'Deploy', 6: 'Relatório', 7: 'Workflows de CI' };

/** "4 · Verificação". The CI workflows (7) are published between phases 2 and 3, so their number would only mislead. */
export function phaseTitle(phase: number): string {
  const name = PHASE_NAMES[phase];
  if (!name) return `Fase ${phase}`;
  return phase <= 6 ? `${phase} · ${name}` : name;
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

export interface DeployFailure {
  attempt: number;
  stage: string;
  detail: string;
  rolledBack: boolean;
  rollbackHealthy: boolean | null;
  /** The service that failed, in a services run. */
  service?: string;
}

/** The latest deploy failure, or null when nothing failed or a later attempt verified. */
export function lastDeployFailure(events: StoredEvent[]): DeployFailure | null {
  let out: DeployFailure | null = null;
  for (const e of events) {
    if (e.type === 'DEPLOY_FAILED') out = { attempt: Number(e.data.attempt), stage: String(e.data.stage), detail: String(e.data.detail ?? ''), rolledBack: e.data.rolledBack === true, rollbackHealthy: typeof e.data.rollbackHealthy === 'boolean' ? e.data.rollbackHealthy : null, ...(typeof e.data.service === 'string' ? { service: e.data.service } : {}) };
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

// First match wins. Reasons are the orchestrator's English strings (server/orchestrator/task-runner.ts, phases/*.ts);
// the anchored ones come first so a failure that quotes an agent's text is matched by its own prefix.
const STOP_RULES: Array<[RegExp, StopExplanation]> = [
  [/^gh repo view failed/, { title: 'Não foi possível consultar o repositório no GitHub', hint: 'Confira se o GitHub CLI está autenticado e tem acesso ao repositório, depois reprocesse a spec.', owner: 'Você' }],
  [/^Phase 1 exhausted/, { title: 'A especificação técnica não cobriu todos os critérios de aceitação', hint: 'Deixe mais claros na spec os critérios citados no detalhe técnico e reprocesse.', owner: 'Você' }],
  [/^Phase 2 exhausted/, { title: 'O plano de tarefas não passou na validação', hint: 'Leia o último motivo no detalhe técnico. Se ele apontar algo ambíguo na spec, ajuste e reprocesse.', owner: 'Sistema' }],
  [/^(service \S+: )?rendered \S+ is invalid/, { title: 'Os workflows de CI gerados a partir do plano são inválidos', hint: 'Revise os comandos do plan.json na main e reprocesse a spec.', owner: 'Plano' }],
  [/^(service \S+: )?docs merge failed/, { title: 'O PR de documentação não entrou na main', hint: 'Confira as permissões e a proteção de branch do repositório e reprocesse a spec.', owner: 'Você' }],
  [/^Phase 6 blocked: documentation rejected/, { title: 'A documentação gerada no relatório foi rejeitada', hint: 'Reprocesse a spec. Se a falha se repetir, o motivo da rejeição está no detalhe técnico.', owner: 'Sistema' }],
  [/^Phase 6 blocked/, { title: 'O relatório final não foi gerado', hint: 'O Scrum Master não devolveu o relatório no formato esperado. Reprocesse a spec para gerar o relatório de novo.', owner: 'Sistema' }],
  [/^delivery contract not met/, { title: 'Faltam arquivos de entrega na main', hint: 'Veja no detalhe técnico quais arquivos faltaram. Se as tarefas ficaram bloqueadas, resolva os bloqueios antes de reprocessar.', owner: 'Sistema' }],
  [/^verification failed in round 2/, { title: 'Os testes de aceitação não passaram', hint: 'Veja na matriz de evidências quais critérios falharam e reporte o problema na tela de validação.', owner: 'Sistema' }],
  [/^fix-tasks rejected twice/, { title: 'O Scrum Master não conseguiu planejar as correções', hint: 'Leia o motivo no detalhe técnico e reprocesse a spec.', owner: 'Sistema' }],
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
  // An agent's own words, not an orchestrator string (runs hello-001-r4 and r5): last, so no prefix above is shadowed.
  [/security-tools'? gate/i, { title: 'As ferramentas de segurança não rodam no ambiente do gate', hint: 'O gate security-tools falha antes de analisar o código, e os arquivos dele são protegidos: nenhum agente consegue corrigir. Ajuste a imagem ou o instalador do gate e reprocesse a spec.', owner: 'Sistema' }],
];

/** A pt-BR explanation of a raw stop reason, or null when it is not one the UI knows (callers then show it raw). */
export function explainStop(reason: string): StopExplanation | null {
  return STOP_RULES.find(([re]) => re.test(reason))?.[1] ?? null;
}

/** The first sentence of a free-text reason, cut to `max` characters: a one-line title for a long explanation. */
export function firstSentence(text: string, max = 160): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

const NEXT_STEP = 'Veja o detalhe técnico. Quando a causa estiver resolvida, reprocesse a spec.';
const DEPLOY_NEXT_STEP = 'O orquestrador esgotou as tentativas de deploy. Veja o detalhe técnico e os logs do container.';

/** What a failed phase row says: the known explanation of its reason, else the reason's first sentence and a generic next step. */
export function explainPhase(row: { phase: number; reason: string | null }): StopExplanation {
  const reason = row.reason ?? '';
  return explainStop(reason) ?? { title: reason ? firstSentence(reason) : `${phaseTitle(row.phase)} falhou`, hint: row.phase === 5 ? DEPLOY_NEXT_STEP : NEXT_STEP, owner: 'Sistema' };
}

/** One sentence tying a failed run to the tasks that blocked on their own, or null when none did. */
export function blockedSummary(blocked: Array<{ taskId: string; reason: string }>): string | null {
  const roots = rootBlockers(blocked);
  if (!roots.length) return null;
  const others = blocked.length - roots.length;
  const stuck = others === 1 ? 'outra tarefa' : `outras ${others} tarefas`;
  if (roots.length === 1) return `${roots[0]!.taskId} ficou bloqueada${others ? ` e travou ${stuck}` : ''}. Sem resolver esse bloqueio, reprocessar tende a repetir a falha.`;
  return `${roots.length} tarefas ficaram bloqueadas${others ? ` e travaram ${stuck}` : ''}. Sem resolver esses bloqueios, reprocessar tende a repetir a falha.`;
}

/** The stop banner's "before that" line; a blocked or deadlocked run's banner already leads with its blocked tasks. */
export function stopBefore(status: string, blocked: Array<{ taskId: string; reason: string }>): string | null {
  return status === 'blocked' || status === 'deadlocked' ? null : blockedSummary(blocked);
}

const STOP_STATUSES = new Set(['deploy-failed', 'verification-failed', 'blocked', 'phase-failed', 'deadlocked', 'failed']);

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
export function stopSummary(input: { status: string; reason: string | null; causes: Array<{ taskId: string; reason: string }>; deployFailure: DeployFailure | null; failedPhase?: number | null }): StopSummary | null {
  const { status, reason, causes, deployFailure } = input;
  if (!STOP_STATUSES.has(status)) return null;
  if (status === 'deploy-failed') {
    const f = deployFailure;
    const raw = f ? f.detail : (reason ?? '');
    const where = f ? `estágio ${f.stage}${f.service ? ` do serviço ${f.service}` : ''}` : '';
    const generic: StopExplanation = { title: f ? `Falha no ${where}` : 'O deploy falhou', hint: DEPLOY_NEXT_STEP, owner: 'Sistema' };
    const why = explainStop(raw) ?? explainStop(reason ?? '') ?? generic;
    const rollback = f?.rolledBack ? (f.rollbackHealthy === false ? 'Rollback feito, mas a versão anterior não respondeu ao healthcheck.' : 'Rollback feito e saudável: a versão anterior continua no ar.') : null;
    return { what: f ? `O deploy falhou no ${where} (tentativa ${f.attempt}).` : 'O deploy falhou.', ...why, raw, rollback, action: 'redeploy' };
  }
  if (status === 'verification-failed') {
    // The verdict is either missing delivery files or failing tests; the reason says which.
    const why = explainStop(reason ?? '');
    return { what: 'A verificação (fase 4) não passou depois de duas rodadas.', title: why?.title ?? 'Os testes de aceitação não passaram', hint: why?.hint ?? 'Veja a matriz de evidências abaixo e reporte o problema na tela de validação.', owner: why?.owner ?? 'Sistema', raw: reason ?? '', rollback: null, action: null };
  }
  if (status === 'deadlocked') {
    return { what: 'Nenhuma tarefa pode avançar.', title: 'Todas as tarefas restantes dependem de uma tarefa bloqueada', hint: 'Resolva primeiro a tarefa bloqueada (veja Tarefas bloqueadas) e reprocesse a spec.', owner: 'Você', raw: reason ?? '', rollback: null, action: null };
  }
  if (status === 'phase-failed' || status === 'failed') {
    const why = explainStop(reason ?? '');
    const where = input.failedPhase === undefined || input.failedPhase === null ? null : phaseTitle(input.failedPhase);
    const what = where ? `A run parou na fase ${where}.` : status === 'failed' ? 'A run falhou.' : 'Uma fase da run falhou.';
    return { what, title: why?.title ?? (reason ? firstSentence(reason) : 'O orquestrador não registrou o motivo'), hint: why?.hint ?? NEXT_STEP, owner: why?.owner ?? 'Sistema', raw: reason ?? '', rollback: null, action: null };
  }
  const first = causes[0];
  const why = (first ? explainStop(first.reason) : null) ?? { title: first ? 'Tarefa bloqueada' : 'Tarefas bloqueadas', hint: 'Abra a tarefa para ver o motivo.', owner: 'Sistema' as StopOwner };
  const n = causes.length;
  return { what: n === 1 ? '1 tarefa ficou bloqueada.' : `${n} tarefas ficaram bloqueadas.`, ...why, raw: first?.reason ?? reason ?? '', rollback: null, action: null };
}

/** Every one of `taskIds` currently sitting blocked, with the reason its own TASK_BLOCKED event carries. Unlike
 * `stopSummary`'s `causes` (built from `RUN_FINISHED.blocked`), this works while the run is still active, so a task
 * stuck mid-run shows its cause immediately instead of only once the whole run eventually stops. */
export function liveBlocked(events: StoredEvent[], taskIds: Iterable<string>): Array<{ taskId: string; reason: string }> {
  const reasons = new Map<string, string>();
  for (const e of events) if (e.type === 'TASK_BLOCKED') reasons.set(String(e.data.taskId), String(e.data.reason));
  return [...taskIds].flatMap((taskId) => {
    const reason = reasons.get(taskId);
    return reason === undefined ? [] : [{ taskId, reason }];
  });
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
    const byBranch = [...branchOf.entries()].find(([b]) => isTaskBranch(b, taskId))?.[1];
    const number = Number(e.data.pr ?? byBranch?.number);
    if (!Number.isFinite(number) || number === 0) continue;
    rows.push({ taskId, number, url: byBranch?.url ?? '' });
  }
  return rows;
}

export type ActivityTone = 'good' | 'bad' | '';
export interface ActivityItem {
  at: string;
  text: string;
  tone: ActivityTone;
  url: string | null;
}
export interface PhaseActivity {
  items: ActivityItem[];
  steps: StepRow[];
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
  report: 'escrevendo o relatório',
  readme: 'escrevendo o README',
  decide: 'tomando uma decisão automática',
  'spec-gap': 'respondendo uma dúvida sobre a spec',
  replan: 'replanejando uma tarefa',
  'fix-tasks': 'criando tarefas de correção',
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
      return item(`Tarefa ${String(d.taskId)} mesclada na main (pull request #${String(d.pr)})`, 'good');
    case 'REBASE_REPLAYED': {
      const files = list(d.files);
      return item(`Tarefa ${String(d.taskId)} movida para a main atual${files.length ? `, com conflitos a resolver em ${files.join(', ')}` : ', sem conflitos a resolver'}`, files.length ? 'bad' : '');
    }
    case 'TASK_BLOCKED':
      return item(`Tarefa ${String(d.taskId)} bloqueada: ${firstSentence(explainBlockReason(String(d.reason ?? '')))}`, 'bad');
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
const hasTask = (d: Record<string, unknown>) => d.taskId !== null && d.taskId !== undefined && d.taskId !== '';

/**
 * Each phase's timeline and its own agent steps; task steps stay in the task detail.
 * An event that names its phase goes there; any other one belongs to the phase that started last before it.
 */
export function phaseActivity(events: StoredEvent[]): Map<number, PhaseActivity> {
  const out = new Map<number, PhaseActivity>();
  const of = (phase: number) => {
    if (!out.has(phase)) out.set(phase, { items: [], steps: [] });
    return out.get(phase)!;
  };
  const stepPhase = new Map<string, number>();
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
    if (e.type === 'STEP_STARTED' && !task) of(phase).steps.push(startedStep(d));
    if (e.type === 'STEP_FINISHED' && !task) {
      const s = of(phase).steps.find((x) => x.stepId === d.stepId);
      if (s) finishStep(s, d);
    }
    if (item && (!task || e.type === 'PR_MERGED' || e.type === 'TASK_BLOCKED' || e.type === 'REBASE_REPLAYED')) of(phase).items.push(item);
  });
  return out;
}

/** The agent steps running right now, oldest first, and the last thing that happened. */
export function currentActivity(events: StoredEvent[]): { running: RunningStep[]; last: ActivityItem | null } {
  const open = new Map<string, RunningStep>();
  let last: ActivityItem | null = null;
  describeAll(events, (e, item) => {
    const d = e.data;
    if (e.type === 'STEP_STARTED') open.set(String(d.stepId), { stepId: String(d.stepId), kind: String(d.kind), role: String(d.role), model: typeof d.model === 'string' ? d.model : null, taskId: hasTask(d) ? String(d.taskId) : null, startedAt: e.at });
    if (e.type === 'STEP_FINISHED') open.delete(String(d.stepId));
    if (item) last = item;
  });
  return { running: [...open.values()], last };
}
