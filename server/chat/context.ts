import path from 'node:path';
import { listProjects, listRuns, readProject, runsDir, type IndexDeps } from '../api/run-index.js';
import type { Spec } from '../contracts/spec.js';
import { reduceEvents } from '../pipeline/run-state.js';
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

async function tasksOf(idx: IndexDeps, runId: string): Promise<string[]> {
  const events = await loadEvents(path.join(runsDir(idx), runId, 'events.ndjson')).catch(() => []);
  const tasks = [...reduceEvents(events).tasks.values()].filter((t) => t.state !== 'superseded');
  const cut = (s: string) => (s.length > MAX_TASK_TEXT ? `${s.slice(0, MAX_TASK_TEXT)}…` : s);
  return tasks.map((t) => `- ${withoutCodes(t.def.title)} (${TASK_STATE[t.state]}): ${cut(withoutCodes(t.def.description))}`);
}

/** Specs being worked on get everything; every other spec is one line (name and situation), which keeps the prompt small. */
const IN_PLAY: ReadonlySet<string> = new Set(['running', 'paused:quota', 'paused:auth', 'awaiting-validation']);

async function specBlock(idx: IndexDeps, spec: Spec, situation: string, runId: string | null): Promise<string> {
  const bug = spec.bug ? [`Problema a corrigir: ${withoutCodes(spec.bug.actual)}`, `O esperado: ${withoutCodes(spec.bug.expected)}`] : [];
  const tasks = runId ? await tasksOf(idx, runId) : [];
  return [
    `### ${withoutCodes(spec.objectives[0]!)}`,
    `Situação: ${situation}`,
    ...bug,
    ...list('Objetivos', spec.objectives),
    ...list('Funcionalidades', spec.features),
    ...list('Fora do escopo (não deve ser feito)', spec.outOfScope),
    ...list('O que precisa funcionar', spec.acceptanceCriteria.map((c) => `Dado ${c.given}, quando ${c.when}, então ${c.then}`)),
    ...list('Tarefas da execução mais recente', tasks),
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
    const latest = runs.find((r) => r.specId === spec.specId && r.kind === 'run');
    const block = await specBlock(idx, spec, situation, latest?.runId ?? null);
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
