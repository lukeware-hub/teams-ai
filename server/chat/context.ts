import path from 'node:path';
import { listProjects, listRuns, readProject, runsDir, type IndexDeps, type RunListStatus, type RunRow } from '../api/run-index.js';
import type { Spec } from '../contracts/spec.js';
import { reduceEvents, type TaskRuntime } from '../pipeline/run-state.js';
import type { TaskState } from '../pipeline/task-state.js';
import { loadEvents } from '../store/event-store.js';

const MAX_CHARS = 60_000;
const MAX_TASK_TEXT = 240;

const SPEC_STATUS: Record<string, string> = {
  refining: 'em refinamento, ainda não planejada',
  planned: 'planejada, ainda não iniciada',
  running: 'em desenvolvimento agora',
  'paused:quota': 'pausada porque a cota de uso acabou',
  'paused:auth': 'pausada por falha de login',
  'awaiting-validation': 'entregue, esperando a validação de uma pessoa',
  done: 'concluída',
  retired: 'descartada, nunca será feita',
};

/** A spec frozen for running with no run going is ready to start, not in development. */
const situationOf = (status: string, active: boolean): string => (status === 'running' && !active ? 'pronta para executar, sem execução ativa' : (SPEC_STATUS[status] ?? status));

const TASK_STATE: Record<TaskState, string> = {
  planned: 'aguardando a vez',
  ready: 'pronta para começar',
  implementing: 'sendo desenvolvida agora',
  validating: 'em testes',
  reviewing: 'em revisão',
  rebasing: 'sendo atualizada com o código mais novo',
  merging: 'sendo incorporada ao código principal',
  merged: 'concluída',
  blocked: 'bloqueada',
  superseded: 'substituída por outra',
};

/** Specs in progress come first, so the cut at the size limit drops the oldest history. */
const ORDER = ['running', 'paused:quota', 'paused:auth', 'planned', 'refining', 'awaiting-validation', 'done', 'retired'];

/** Removes criterion and task codes, which a lay reader cannot use. */
export const withoutCodes = (text: string): string =>
  text.replace(/\[?\b(?:AC-\d+|T\d+(?:-[a-z0-9]+)*)\b\]?/g, '').replace(/\(\s*[,;]?\s*\)/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

const list = (title: string, items: readonly string[]): string[] => (items.length ? [`${title}:`, ...items.map((i) => `- ${withoutCodes(i)}`)] : []);

/** The tasks of one run, without the ones a later plan replaced. */
async function tasksOf(idx: IndexDeps, runId: string): Promise<TaskRuntime[]> {
  const events = await loadEvents(path.join(runsDir(idx), runId, 'events.ndjson')).catch(() => []);
  return [...reduceEvents(events).tasks.values()].filter((t) => t.state !== 'superseded');
}

const taskLine = (t: TaskRuntime): string => {
  const description = withoutCodes(t.def.description);
  const cut = description.length > MAX_TASK_TEXT ? `${description.slice(0, MAX_TASK_TEXT)}…` : description;
  return `${withoutCodes(t.def.title)} (${TASK_STATE[t.state]}): ${cut}`;
};

const IN_PROGRESS: ReadonlySet<TaskState> = new Set(['implementing', 'validating', 'reviewing', 'rebasing', 'merging']);
const progressOf = (tasks: readonly TaskRuntime[]): string =>
  `Progresso: ${tasks.filter((t) => t.state === 'merged').length} de ${tasks.length} tarefas concluídas, ${tasks.filter((t) => IN_PROGRESS.has(t.state)).length} em andamento`;

/** How a run's status reads in the context; any status not listed here reads as finished. */
const RUN_STATUS: Partial<Record<RunListStatus, string>> = {
  running: 'em andamento',
  draining: 'encerrando',
  'paused:quota': 'pausada porque a cota de uso acabou',
  'paused:auth': 'pausada por falha de login',
  'awaiting-validation': 'esperando a validação de uma pessoa',
  interrupted: 'interrompida',
};

/** Specs being worked on get everything; every other spec is one line (name and situation), which keeps the prompt small. */
const IN_PLAY: ReadonlySet<string> = new Set(['running', 'paused:quota', 'paused:auth', 'awaiting-validation']);

async function specBlock(idx: IndexDeps, spec: Spec, situation: string, run: RunRow | null): Promise<string> {
  const bug = spec.bug ? [`Problema a corrigir: ${withoutCodes(spec.bug.actual)}`, `O esperado: ${withoutCodes(spec.bug.expected)}`] : [];
  const tasks = run ? await tasksOf(idx, run.runId) : [];
  return [
    `### ${withoutCodes(spec.objectives[0]!)}`,
    `Situação: ${situation}`,
    `Nome da spec: ${spec.specId}`,
    ...(run ? [`Execução: número ${run.n} (${RUN_STATUS[run.status] ?? 'encerrada'})`, progressOf(tasks)] : []),
    ...bug,
    ...list('Objetivos', spec.objectives),
    ...list('Funcionalidades', spec.features),
    ...list('Fora do escopo (não deve ser feito)', spec.outOfScope),
    ...list('O que precisa funcionar', spec.acceptanceCriteria.map((c) => `Dado ${c.given}, quando ${c.when}, então ${c.then}`)),
    ...list('Tarefas da execução mais recente', tasks.map(taskLine)),
  ].join('\n');
}

/** Everything the chat may know about one project, in plain words and without codes; null when the project is unknown. */
export async function buildChatContext(idx: IndexDeps, projectId: string): Promise<{ name: string; text: string } | null> {
  const row = (await listProjects(idx)).find((p) => p.projectId === projectId);
  if (!row) return null;
  const { project, specs } = await readProject(row.dir);
  const runs = await listRuns(idx, projectId);
  const rows = new Map(row.specs.map((s) => [s.specId, s]));
  const ordered = specs
    .map((spec) => ({ spec, status: rows.get(spec.specId)?.status ?? spec.status, active: rows.get(spec.specId)?.activeRunId != null }))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const head = [`## Projeto: ${project.name}`, `Visão: ${withoutCodes(project.vision)}`, '', '## Specs (as entregas planejadas do projeto)'].join('\n');
  const blocks: string[] = [];
  const others: string[] = [];
  let size = head.length;
  for (const { spec, status, active } of ordered) {
    const situation = situationOf(status, active);
    if (!IN_PLAY.has(status)) {
      others.push(`- ${withoutCodes(spec.objectives[0]!)}: ${situation}`);
      continue;
    }
    // The run in progress; without one, the latest run of the spec.
    const latest = runs.find((r) => r.specId === spec.specId && r.kind === 'run');
    const run = runs.find((r) => r.runId === rows.get(spec.specId)?.activeRunId) ?? latest ?? null;
    const block = await specBlock(idx, spec, situation, run);
    if (size + block.length > MAX_CHARS) {
      others.push(`- ${withoutCodes(spec.objectives[0]!)}: ${situation} (sem detalhes por causa do tamanho)`);
      continue;
    }
    blocks.push(block);
    size += block.length;
  }
  const rest = others.length ? [`### Outras specs (só o nome e a situação)\n${others.join('\n')}`] : [];
  return { name: project.name, text: [head, blocks.length || rest.length ? [...blocks, ...rest].join('\n\n') : '(o projeto ainda não tem specs)'].join('\n\n') };
}
