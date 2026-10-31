import { promises as fs } from 'node:fs';
import path from 'node:path';
import { finishOf, type RunListStatus, type RunRow } from '../api/run-index.js';
import type { Spec } from '../contracts/spec.js';
import { redactSecrets } from '../core/redact.js';
import { OrchEvent } from '../orchestrator/events.js';
import { ownerAnswer, readOwnerDecisions } from '../orchestrator/owner-decisions.js';
import { rootBlocks } from '../orchestrator/phases/gaps.js';
import { blockExplanation, explainPhase, explainStop, firstSentence, groupCauses, lastDeployFailure, ownHint, phaseTitle, stopSummary, type DeployFailure, type StopOwner } from '../orchestrator/stop-explain.js';
import { reduceEvents, RunEvent, type TaskRuntime } from '../pipeline/run-state.js';
import { DEPENDENCY_BLOCKED } from '../pipeline/task-state.js';
import { loadEvents, type StoredEvent } from '../store/event-store.js';
import { RUN_STATUS, runLabel, TASK_STATE } from './status.js';
import { clip, withoutCodes } from './text.js';

export interface Failures {
  /** The facts of one spec the chat reads in its context, most important first and within the size given. */
  digest: string;
  /** Everything the record holds about the spec, for the detail file the chat can search. */
  detail: string;
}

/** One run's journal, read in full: its events and the tasks it holds, the latest plan of each. */
export interface RunRecord {
  events: StoredEvent[];
  tasks: TaskRuntime[];
}

/** Reads and replays one run's journal; null when it cannot be read, so one corrupt journal never stops the chat. */
export async function readRun(runs: string, runId: string): Promise<RunRecord | null> {
  try {
    const events = await loadEvents(path.join(runs, runId, 'events.ndjson'));
    return { events, tasks: [...reduceEvents(events).tasks.values()].filter((t) => t.state !== 'superseded') };
  } catch {
    return null;
  }
}

export interface FailureInput {
  spec: Spec;
  /** The project folder: the owner's answers are kept there. */
  root: string;
  /** The runs folder. */
  runs: string;
  /** The run the chat leads with. */
  run: RunRow;
  /** That run's journal, or null when it cannot be read. */
  record: RunRecord | null;
  /** The run that holds the spec right now, when there is one. */
  holds: RunRow | null;
  /** The other runs of the spec, newest first. */
  history: RunRow[];
  /** The status of every run of the spec, the latest included. */
  runStatuses: readonly RunListStatus[];
  /** The known secret values, masked out of every recorded text. */
  secrets: readonly string[];
  /** Whether the agents decide the blocks of this project themselves. */
  autonomous: boolean;
  /** The size the digest may take. */
  digestMax: number;
}

/** What the chat says about a run status that no stop summary covers. */
const STATUS_NOTE: Partial<Record<RunListStatus, { what: string; title: string; owner: StopOwner; hint: string }>> = {
  interrupted: { what: 'A execução parou antes do fim.', title: 'O processo da execução foi encerrado', owner: 'Você', hint: 'Use Retomar na tela da execução.' },
  'paused:quota': { what: 'A execução está pausada.', title: 'O limite de uso do Claude acabou', owner: 'Sistema', hint: 'Nada a fazer: a execução continua sozinha quando o limite renovar.' },
  'paused:auth': { what: 'A execução está pausada.', title: 'A sessão do Claude expirou', owner: 'Você', hint: 'Entre de novo no Claude e use Retomar.' },
  'awaiting-validation': { what: 'A entrega terminou e está publicada.', title: 'Falta a validação de uma pessoa', owner: 'Você', hint: 'Valide o resultado na tela de validação.' },
  draining: { what: 'A execução está encerrando.', title: 'Você pediu para parar', owner: 'Sistema', hint: 'Nada a fazer: ela termina a etapa em curso e encerra.' },
  drained: { what: 'A execução foi encerrada.', title: 'Encerrada depois de você pedir para parar', owner: 'Você', hint: 'Use Reprocessar se quiser continuar.' },
  'launch-failed': { what: 'A execução não chegou a começar.', title: 'O processo não iniciou', owner: 'Sistema', hint: 'Use Reprocessar na tela da spec.' },
  unknown: { what: 'O status da execução não foi registrado.', title: 'Sem registro de status', owner: 'Sistema', hint: 'Veja o registro completo no arquivo de falhas.' },
};
/** The statuses whose stop summary the run screen already words. */
const STOP_STATUSES: ReadonlySet<RunListStatus> = new Set(['deploy-failed', 'verification-failed', 'phase-failed', 'deadlocked']);
const OWNER: Record<StopOwner, string> = { Você: 'você', Sistema: 'o sistema', Plano: 'o plano do projeto' };
const NO_REASON = 'Motivo não registrado';
/** Whose words a cause is: a reviewer's finding is an agent's opinion; the other causes are what the system recorded. */
const originOf = (reason: string): string => (/^(Security review|Review) requested changes|^Review evidence rejected/.test(reason) ? 'agente revisor (opinião de um agente, não fato do sistema)' : 'sistema');

/** The UTC time of a record, to the minute. */
const when = (at: string | null): string => (at ? `${at.slice(0, 16).replace('T', ' ')} UTC` : 'hora não registrada');
/** A sentence ends with a full stop. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);
/** A multi-line text on one line, for the digest. */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' | ');

interface Remade {
  taskId: string;
  cause: string | null;
  replacements: string[];
  descriptions: string[];
}

/** What the journal records about the run, read in one pass; the replan descriptions are agent text, kept apart. Throws when the journal does not replay. */
interface Facts {
  tasks: Map<string, TaskRuntime>;
  reasons: Map<string, string>;
  /** When each task last blocked, as the journal recorded it. */
  blockedAt: Map<string, string>;
  asked: Array<{ taskId: string; runId: string; question: string }>;
  remade: Remade[];
  verification: Record<string, unknown> | null;
  phaseFailed: { phase: number; reason: string } | null;
  finishedReason: string | null;
  deploy: DeployFailure | null;
  reopened: number;
  unblocked: number;
  empty: boolean;
}

function readFacts(events: readonly StoredEvent[]): Facts {
  const { tasks } = reduceEvents(events);
  const reasons = new Map<string, string>();
  const blockedAt = new Map<string, string>();
  const asked: Facts['asked'] = [];
  const lastAttempt = new Map<string, string>();
  const remade: Remade[] = [];
  let verification: Record<string, unknown> | null = null;
  let phaseFailed: Facts['phaseFailed'] = null;
  let reopened = 0;
  let unblocked = 0;
  for (const e of events) {
    const d = e.data;
    if (e.type === OrchEvent.TaskBlocked) {
      reasons.set(String(d.taskId), String(d.reason));
      blockedAt.set(String(d.taskId), e.at);
    } else if (e.type === OrchEvent.Feedback && d.attempt === true) lastAttempt.set(String(d.taskId), String(d.text));
    else if (e.type === RunEvent.TaskReplanned) {
      const id = String(d.taskId);
      const replacements = d.replacements as Array<{ id: string; description: string }>;
      remade.push({ taskId: id, cause: lastAttempt.get(id) ?? null, replacements: replacements.map((r) => r.id), descriptions: replacements.map((r) => r.description) });
    } else if (e.type === OrchEvent.DecisionRequested) asked.push({ taskId: String(d.taskId), runId: e.runId, question: String(d.question) });
    else if (e.type === OrchEvent.VerificationFailed) verification = d;
    else if (e.type === OrchEvent.PhaseFailed) phaseFailed = { phase: Number(d.phase), reason: String(d.reason ?? '') };
    else if (e.type === RunEvent.RunReopened) reopened += 1;
    else if (e.type === RunEvent.TasksUnblocked) unblocked += Array.isArray(d.taskIds) ? d.taskIds.length : 0;
  }
  const reason = finishOf(events)?.data.reason;
  return {
    tasks,
    reasons,
    blockedAt,
    asked,
    remade,
    verification,
    phaseFailed,
    finishedReason: typeof reason === 'string' && reason !== '' ? reason : null,
    deploy: lastDeployFailure(events),
    reopened,
    unblocked,
    empty: events.length === 0,
  };
}

/** The blocks of one run, grouped by cause; a journal that does not replay gives none. */
function causesOfRun(events: readonly StoredEvent[] | null): Array<{ reason: string; taskIds: string[] }> {
  if (events === null) return [];
  try {
    const facts = readFacts(events);
    // Every recorded block counts, even of a task replanned or unblocked later: the record of the run keeps its causes.
    return groupCauses([...facts.reasons].map(([taskId, reason]) => ({ taskId, reason })).filter((c) => c.reason !== DEPENDENCY_BLOCKED));
  } catch {
    return [];
  }
}

/** Keeps the lines that fit, in order, and reserves room for the pointer; the pointer closes the list when some do not. */
export function fit(lines: readonly string[], max: number, pointer: string): string {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 + pointer.length + 1 > max) {
      out.push(pointer);
      return out.join('\n');
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

interface Tier {
  quote: number;
  history: number;
  remade: number;
}
/** From the richest digest to the leanest: quotes shrink first, then the lists of earlier runs and of remade tasks. */
const TIERS: readonly Tier[] = [
  { quote: 350, history: 3, remade: 2 },
  { quote: 200, history: 3, remade: 2 },
  { quote: 200, history: 1, remade: 1 },
  { quote: 120, history: 0, remade: 0 },
];

/** The recorded facts of one spec's run: a short digest for the context and the full record for the detail file. Nothing here is a guess. */
export async function failureReport(input: FailureInput): Promise<Failures> {
  const { spec, run, holds, history, secrets, autonomous, record } = input;
  // Rules read the redacted text, cut at a size they can cope with; the reader sees it without codes too.
  const rule = (text: string) => clip(redactSecrets(text, secrets), 20_000);
  const say = (text: string, max: number) => clip(withoutCodes(redactSecrets(text, secrets)), max);

  let facts: Facts | null = null;
  try {
    facts = record === null ? null : readFacts(record.events);
  } catch {
    facts = null;
  }
  const answers = await readOwnerDecisions(input.root, spec.specId);
  const answerOf = (taskId: string, runId: string, question: string) => ownerAnswer(answers, runId, taskId, question);
  const titleOf = (taskId: string) => say(facts?.tasks.get(taskId)?.def.title ?? 'tarefa sem título', 120);
  const replacementOf = (taskId: string) => {
    const state = facts?.tasks.get(taskId)?.state;
    return state ? `"${titleOf(taskId)}" (${TASK_STATE[state]})` : `"${titleOf(taskId)}"`;
  };
  const reasonOf = (taskId: string) => rule(facts?.reasons.get(taskId) ?? NO_REASON);
  const statusLine = `Execução mais recente: número ${run.n}, ${runLabel(run)}, em ${when(run.at)}.`;

  const live = facts ? [...facts.tasks.values()].filter((t) => t.state !== 'superseded') : [];
  const blocked = live.filter((t) => t.state === 'blocked');
  const causeTasks = blocked
    .filter((t) => reasonOf(t.def.id) !== DEPENDENCY_BLOCKED)
    .map((t) => ({ taskId: t.def.id, reason: reasonOf(t.def.id), at: facts?.blockedAt.get(t.def.id) ?? null, attempts: t.attempts }));
  const causes = groupCauses(causeTasks);
  const members = new Map(causeTasks.map((c) => [c.taskId, c] as const));
  const since = (group: { taskIds: string[] }): string | null => group.taskIds.map((id) => members.get(id)!.at).filter((t): t is string => t !== null).sort()[0] ?? null;
  const attemptsOf = (group: { taskIds: string[] }): number => group.taskIds.reduce((n, id) => n + members.get(id)!.attempts, 0);

  // A task blocked only because another one is: it waits for the cause the walk over its dependencies reaches.
  const waiting = causes.map(() => 0);
  let unexplained = 0;
  let behindReplaced = 0;
  let pendingOther = 0;
  if (facts) {
    const graph = new Map([...facts.tasks].map(([id, t]) => [id, { state: t.state, dependsOn: t.def.dependsOn }] as const));
    const ctx = { tasks: graph, reasonOf: (id: string) => facts.reasons.get(id) ?? '' };
    for (const t of blocked.filter((b) => reasonOf(b.def.id) === DEPENDENCY_BLOCKED)) {
      const roots = rootBlocks(t.def.dependsOn, ctx);
      const index = roots.length > 0 ? causes.findIndex((c) => c.taskIds.includes(roots[0]!.taskId)) : -1;
      if (index >= 0) waiting[index]! += 1;
      else if (t.def.dependsOn.some((d) => facts.tasks.get(d)?.state === 'superseded')) behindReplaced += 1;
      else if (t.def.dependsOn.some((d) => { const s = facts.tasks.get(d)?.state; return s !== undefined && s !== 'merged'; })) pendingOther += 1;
      else unexplained += 1;
    }
  }
  const ranked = causes.map((c, i) => ({ c, waits: waiting[i]! })).sort((a, b) => b.c.taskIds.length + b.waits - (a.c.taskIds.length + a.waits));

  const reason = facts?.finishedReason ?? facts?.phaseFailed?.reason ?? null;
  let stop: { what: string; title: string; owner: StopOwner; hint: string; raw: string } | null = null;
  if (run.status === 'phase-failed' && facts?.phaseFailed) {
    const why = explainPhase({ phase: facts.phaseFailed.phase, reason: rule(facts.phaseFailed.reason) }, autonomous);
    stop = { what: `A execução parou na fase ${phaseTitle(facts.phaseFailed.phase)}.`, title: why.title, owner: why.owner, hint: why.hint, raw: facts.phaseFailed.reason };
  } else if (STOP_STATUSES.has(run.status)) {
    const summary = stopSummary({ status: run.status, reason: reason === null ? null : rule(reason), causes: causeTasks, deployFailure: facts?.deploy ?? null, failedPhase: facts?.phaseFailed?.phase ?? null, autonomous });
    if (summary) stop = { what: summary.what, title: summary.title, owner: summary.owner, hint: summary.hint, raw: summary.raw };
  } else if (STATUS_NOTE[run.status]) {
    const note = STATUS_NOTE[run.status]!;
    stop = { what: note.what, title: note.title, owner: note.owner, hint: ownHint(note.hint, autonomous), raw: '' };
  }

  const pending = facts ? facts.asked.filter((q) => q.runId === run.runId && facts.tasks.get(q.taskId)?.state === 'blocked' && answerOf(q.taskId, q.runId, q.question) === null) : [];
  const verification = run.status === 'verification-failed' ? (facts?.verification ?? null) : null;
  // The gate that failed beside the verification, read from the reason the verification gave.
  const gate = run.status === 'verification-failed' ? (/; gate (\S+) failed/.exec(reason ?? '')?.[1] ?? null) : null;
  const criterionText = (id: string) => {
    const ac = spec.acceptanceCriteria.find((a) => a.id === id);
    return ac ? `dado ${say(ac.given, 200)}, quando ${say(ac.when, 200)}, então ${say(ac.then, 200)}` : say(id, 120);
  };

  const pastRuns = await Promise.all(
    history.slice(0, 5).map(async (h) => {
      const events = (await readRun(input.runs, h.runId))?.events ?? null;
      const finished = events ? finishOf(events)?.data.reason : undefined;
      const text = typeof finished === 'string' && finished !== '' ? finished : null;
      const title = text === null ? null : (explainStop(rule(text))?.title ?? firstSentence(rule(text)));
      return { row: h, title, text, events };
    }),
  );
  const pastLine = (p: (typeof pastRuns)[number]) => `número ${p.row.n}, ${runLabel(p.row)}, em ${when(p.row.at)}${p.title ? ` (${say(p.title, 120)})` : ''}`;

  const build = (tier: Tier): string[] => {
    const quote = (text: string, max: number) => oneLine(say(text, Math.min(max, tier.quote)));
    const digest: string[] = [statusLine];
    const tally = new Map<string, number>();
    for (const status of input.runStatuses) tally.set(RUN_STATUS[status], (tally.get(RUN_STATUS[status]) ?? 0) + 1);
    digest.push(`Execuções desta spec: ${input.runStatuses.length} no total (${[...tally].map(([label, n]) => `${n} ${label}`).join(', ')}).`);
    if (facts?.reopened) digest.push(`Reaberta pelo dono ${facts.reopened} vez(es).`);
    if (facts?.unblocked) digest.push(`Tarefas que o dono desbloqueou: ${facts.unblocked}.`);
    if (holds && holds.runId !== run.runId) digest.push(`A execução ${holds.n} é a que segura a spec, mas só a mais recente (número ${run.n}) pode ser retomada.`);
    if (blocked.length) digest.push(`Tarefas bloqueadas: ${blocked.length}.`);
    for (const p of pending.slice(0, 2)) digest.push(`Pergunta pendente de você: ${say(p.question, 300)} (tarefa: ${titleOf(p.taskId)}; feita por um agente).`);
    if (stop) digest.push(`Por que a execução parou: ${sentence(stop.title)} Quem resolve: ${OWNER[stop.owner]}. Próximo passo: ${stop.hint}${stop.raw ? ` Registro: "${quote(stop.raw, 450)}"` : ''}`);
    if (gate) digest.push(`Gate que também falhou na verificação: ${gate} (${explainStop(`Gate ${gate} failed (code, exit 1)`)?.title ?? gate}).`);
    if (ranked.length) digest.push('Causas dos bloqueios, da que segura mais tarefas:');
    for (const [i, { c, waits }] of ranked.slice(0, 3).entries()) {
      const why = blockExplanation(c.reason, autonomous);
      digest.push(`${i + 1}. ${sentence(why.title)} Origem: ${originOf(c.reason)}. ${c.taskIds.length} tarefa(s) bloqueada(s) por isto; ${waits} esperam por ela. Desde ${when(since(c))}; ${attemptsOf(c)} tentativa(s). Quem resolve: ${OWNER[why.owner]}. Próximo passo: ${why.next} Registro: "${quote(c.reason, 350)}"`);
    }
    if (ranked.length > 3) digest.push(`Mais ${ranked.length - 3} causa(s): veja falhas/${spec.specId}.md.`);
    if (unexplained) digest.push(`Tarefas esperando sem causa registrada: ${unexplained}.`);
    if (behindReplaced) digest.push(`Tarefas que dependem de uma tarefa substituída: ${behindReplaced}.`);
    if (pendingOther) digest.push(`Tarefas esperando outra tarefa que ainda não foi concluída: ${pendingOther}.`);
    if (verification) {
      const uncovered = (verification.uncoveredAcs as string[] | undefined) ?? [];
      const failed = (verification.failedTests as string[] | undefined) ?? [];
      const missing = (verification.missingDelivery as string[] | undefined) ?? [];
      if (uncovered.length) digest.push(`Critérios sem teste aprovado: ${uncovered.slice(0, 3).map(criterionText).join('; ')}${uncovered.length > 3 ? ` e mais ${uncovered.length - 3}` : ''}.`);
      if (failed.length) digest.push(`Testes que falharam: ${failed.slice(0, 3).map((t) => say(t, 120)).join('; ')}.`);
      if (missing.length) digest.push(`Arquivos de entrega que faltam: ${missing.slice(0, 5).map((m) => say(m, 120)).join(', ')}.`);
    }
    for (const r of (facts?.remade ?? []).slice(0, tier.remade)) {
      const cause = r.cause === null ? 'sem causa registrada' : `causa registrada: "${quote(r.cause, 350)}"`;
      digest.push(`Refeita pelo plano: "${titleOf(r.taskId)}" (${cause}). Substituída por: ${r.replacements.map(replacementOf).join(', ')}.`);
    }
    // The verification failures of the earlier runs, named here so a question about them needs no search of the detail file.
    const earlierGates = pastRuns.slice(0, 5).flatMap((p) => causesOfRun(p.events).filter((g) => /^Gate \S+ failed/.test(g.reason)).slice(0, 1).map((g) => `número ${p.row.n}: "${quote(g.reason, 220)}"`));
    if (earlierGates.length && tier.history > 0) digest.push(`Falhas de verificação em execuções anteriores: ${earlierGates.slice(0, 2).join('; ')}.`);
    if (pastRuns.length && tier.history > 0) digest.push(`Execuções anteriores: ${pastRuns.slice(0, tier.history).map(pastLine).join('; ')}.`);
    if (facts?.empty) digest.push('Esta execução ainda não registrou nenhum fato.');
    if (record === null || facts === null) digest.push('O registro de eventos desta execução não pôde ser lido.');
    else if (!facts.empty && !stop && !blocked.length && !pending.length) digest.push('Nenhum bloqueio ou falha registrada nesta execução.');
    return digest;
  };

  let lines: string[] = [];
  for (const tier of TIERS) {
    lines = build(tier);
    if (lines.join('\n').length <= input.digestMax) break;
  }
  const digest = fit(lines, input.digestMax, `Detalhes completos: falhas/${spec.specId}.md.`);

  // The detail file: the whole record, labelled, with each agent text marked as an opinion.
  const detail: string[] = [`# Falhas registradas: ${say(spec.objectives[0] ?? spec.specId, 200)}`, `Nome da spec: ${spec.specId}`, '', '## Execução mais recente', statusLine];
  if (stop) detail.push('', '## Por que a execução parou', `O que aconteceu: ${stop.what}`, `Motivo: ${sentence(stop.title)}`, `Quem resolve: ${OWNER[stop.owner]}.`, `Próximo passo: ${stop.hint}`, ...(stop.raw ? ['Registro (texto original):', say(stop.raw, 1800)] : []));
  if (causes.length) detail.push('', '## Causas dos bloqueios');
  for (const { c, waits } of ranked) {
    const why = blockExplanation(c.reason, autonomous);
    detail.push('', `### ${sentence(why.title)}`, `Origem: ${originOf(c.reason)}.`, `Quem resolve: ${OWNER[why.owner]}.`, `Próximo passo: ${why.next}`, `Tarefas bloqueadas por esta causa: ${c.taskIds.map(titleOf).join(', ')}.`, `Tarefas que esperam por ela: ${waits}.`, `Desde ${when(since(c))}; ${attemptsOf(c)} tentativa(s).`, 'Registro (texto original):', say(c.reason, 1800));
    for (const f of why.findings) detail.push(`- ${say(f.where, 200)} (${f.severity}): ${say(f.problem, 400)}${f.fix ? ` Correção pedida: ${say(f.fix, 400)}` : ''}`);
  }
  if (facts?.remade.length) detail.push('', '## Tarefas refeitas pelo plano');
  for (const r of facts?.remade ?? []) {
    detail.push('', `### ${titleOf(r.taskId)}`, `Causa registrada (texto original): ${r.cause === null ? 'nenhuma registrada' : say(r.cause, 1800)}`, `Substituída por: ${r.replacements.map(replacementOf).join(', ')}.`, `Texto de agente (não é causa registrada): ${r.descriptions.map((d) => say(d, 600)).join(' ')}`);
  }
  const asked = facts ? facts.asked.filter((q) => q.runId === run.runId) : [];
  if (asked.length) detail.push('', '## Perguntas ao dono');
  for (const q of asked) {
    const answer = answerOf(q.taskId, q.runId, q.question);
    detail.push(`- ${say(q.question, 400)} Feita por um agente. Tarefa: ${titleOf(q.taskId)}. Resposta: ${answer === null ? 'ainda não respondida' : say(answer, 400)}.`);
  }
  if (verification) {
    detail.push('', '## Verificação');
    for (const id of ((verification.uncoveredAcs as string[] | undefined) ?? []).slice(0, 20)) detail.push(`- Sem teste aprovado: ${criterionText(id)}.`);
    for (const t of ((verification.failedTests as string[] | undefined) ?? []).slice(0, 20)) detail.push(`- Teste que falhou: ${say(t, 200)}.`);
    for (const m of ((verification.missingDelivery as string[] | undefined) ?? []).slice(0, 20)) detail.push(`- Arquivo de entrega que falta: ${say(m, 200)}.`);
  }
  if (pastRuns.length) detail.push('', '## Execuções anteriores', ...pastRuns.map((p) => `- ${pastLine(p)}.`));
  // The reason and the causes of each earlier run, so a question about its failure finds the recorded text in the file.
  for (const p of pastRuns) {
    if (p.text !== null) detail.push('', `### Motivo registrado da execução anterior número ${p.row.n}`, `Registro (texto original): ${say(p.text, 1800)}`);
    const groups = causesOfRun(p.events);
    if (groups.length) detail.push('', `### Causas da execução anterior número ${p.row.n}`, ...groups.map((g) => `- ${sentence(blockExplanation(rule(g.reason), autonomous).title)} Origem: ${originOf(g.reason)}. Tarefas: ${g.taskIds.length}. Registro (texto original): ${say(g.reason, 600)}`));
  }
  if (record === null || facts === null || facts.empty) {
    const uiLog = await fs.readFile(path.join(input.runs, run.runId, 'ui.log'), 'utf8').catch(() => '');
    detail.push('', '## Registro da execução', record === null || facts === null ? 'O registro de eventos desta execução não pôde ser lido.' : 'Esta execução ainda não registrou nenhum fato.', ...(uiLog ? ['Fim do registro de acompanhamento:', say(uiLog.slice(-2000), 2000)] : []));
  }

  return { digest, detail: clip(detail.join('\n'), 20_000) };
}
