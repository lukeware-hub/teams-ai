import { agentsDecideFor } from '../config/config.js';
import { listProjects, listRuns, readProject, runsDir, type IndexDeps, type RunRow } from '../api/run-index.js';
import type { Spec } from '../contracts/spec.js';
import { loadSecretValues } from '../core/secrets.js';
import { expandHome, workspacePaths } from '../orchestrator/workspace.js';
import type { TaskRuntime } from '../pipeline/run-state.js';
import type { TaskState } from '../pipeline/task-state.js';
import { failureReport, readRun } from './failures.js';
import { runLabel, TASK_STATE } from './status.js';
import { withoutCodes } from './text.js';

export { withoutCodes } from './text.js';

const MAX_CHARS = 60_000;
const MAX_TASK_TEXT = 240;
/** The problems of every spec in play share this much text; one spec gets up to the per-spec share. */
const DIGEST_TOTAL = 10_000;
const DIGEST_SPEC_MIN = 1_200;
const DIGEST_SPEC_MAX = 5_000;
/** A spec left with less than this of the total gets only the pointer to its record. */
const DIGEST_FLOOR = 300;

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

/** Specs in progress come first, so the cut at the size limit drops the oldest history. */
const ORDER = ['running', 'paused:quota', 'paused:auth', 'planned', 'refining', 'awaiting-validation', 'done', 'retired'];
/** Specs being worked on get everything; every other spec is one line (name and situation), which keeps the prompt small. */
const IN_PLAY: ReadonlySet<string> = new Set(['running', 'paused:quota', 'paused:auth', 'awaiting-validation']);
/** The runs whose spec is being developed right now. */
const LIVE: ReadonlySet<string> = new Set(['running', 'draining']);
const IN_PROGRESS: ReadonlySet<TaskState> = new Set(['implementing', 'validating', 'reviewing', 'rebasing', 'merging']);

/** A spec in development counts only while its run is live; a run that stopped says what it is. */
const situationOf = (status: string, holds: RunRow | null, latest: RunRow | null): string => {
  if (status !== 'running') return SPEC_STATUS[status] ?? status;
  if (holds && LIVE.has(holds.status)) return 'em desenvolvimento agora';
  if (holds) return `execução ${holds.n} está ${runLabel(holds)}`;
  if (latest) return `sem execução em andamento; a última (número ${latest.n}) está ${runLabel(latest)}`;
  return 'pronta para executar, sem execução ativa';
};

const list = (title: string, items: readonly string[]): string[] => (items.length ? [`${title}:`, ...items.map((i) => `- ${withoutCodes(i)}`)] : []);

/** A replanned task's own text is an agent's note: its title and state are all the chat states. */
const taskLine = (t: TaskRuntime): string => {
  if (t.replanned) return `${withoutCodes(t.def.title)} (${TASK_STATE[t.state]}, criada ao refazer o plano)`;
  const description = withoutCodes(t.def.description);
  const cut = description.length > MAX_TASK_TEXT ? `${description.slice(0, MAX_TASK_TEXT)}…` : description;
  return `${withoutCodes(t.def.title)} (${TASK_STATE[t.state]}): ${cut}`;
};

const progressOf = (tasks: readonly TaskRuntime[]): string =>
  `Progresso: ${tasks.filter((t) => t.state === 'merged').length} de ${tasks.length} tarefas concluídas, ${tasks.filter((t) => IN_PROGRESS.has(t.state)).length} em andamento`;

function specBlock(spec: Spec, situation: string, run: RunRow | null, tasks: readonly TaskRuntime[]): string {
  const bug = spec.bug ? [`Problema a corrigir: ${withoutCodes(spec.bug.actual)}`, `O esperado: ${withoutCodes(spec.bug.expected)}`] : [];
  return [
    `### ${withoutCodes(spec.objectives[0]!)}`,
    `Situação: ${situation}`,
    `Nome da spec: ${spec.specId}`,
    ...(run ? [`Execução: número ${run.n} (${runLabel(run)})`, progressOf(tasks)] : []),
    ...bug,
    ...list('Objetivos', spec.objectives),
    ...list('Funcionalidades', spec.features),
    ...list('Fora do escopo (não deve ser feito)', spec.outOfScope),
    ...list('O que precisa funcionar', spec.acceptanceCriteria.map((c) => `Dado ${c.given}, quando ${c.when}, então ${c.then}`)),
    ...list('Tarefas da execução mais recente', tasks.map(taskLine)),
  ].join('\n');
}

/**
 * Everything the chat may know about one project, in plain words and without codes; null when the project is unknown.
 * `details` holds each spec's full record of failures, for the chat to search; `specIds` names the specs, for the web search check.
 */
export async function buildChatContext(idx: IndexDeps, projectId: string): Promise<{ name: string; text: string; details: Map<string, string>; specIds: string[] } | null> {
  const row = (await listProjects(idx)).find((p) => p.projectId === projectId);
  if (!row) return null;
  const { project, specs } = await readProject(row.dir);
  const runs = await listRuns(idx, projectId);
  const rows = new Map(row.specs.map((s) => [s.specId, s]));
  const ordered = specs
    .map((spec) => ({ spec, status: rows.get(spec.specId)?.status ?? spec.status }))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const head = [`## Projeto: ${project.name}`, `Visão: ${withoutCodes(project.vision)}`, '', '## Specs (as entregas planejadas do projeto)'].join('\n');
  const secrets = [...(await loadSecretValues(expandHome(idx.cfg.paths.secrets, idx.home))), ...(await loadSecretValues(workspacePaths(idx.cfg, projectId, idx.home).secrets))];
  const autonomous = agentsDecideFor(idx.cfg, projectId);
  const playing = ordered.filter(({ status }) => IN_PLAY.has(status)).length;
  const share = Math.min(DIGEST_SPEC_MAX, Math.max(DIGEST_SPEC_MIN, Math.floor(DIGEST_TOTAL / Math.max(1, playing))));
  let remaining = DIGEST_TOTAL;
  const details = new Map<string, string>();
  const others: string[] = [];
  const blocks: Array<{ name: string; situation: string; block: string; digest: string | null }> = [];
  for (const { spec, status } of ordered) {
    if (!IN_PLAY.has(status)) {
      others.push(`- ${withoutCodes(spec.objectives[0]!)}: ${situationOf(status, null, null)}`);
      continue;
    }
    const holds = runs.find((r) => r.runId === rows.get(spec.specId)?.activeRunId) ?? null;
    const own = runs.filter((r) => r.specId === spec.specId && r.kind === 'run').sort((a, b) => b.n - a.n);
    const latest = own[0] ?? null;
    // The run in progress leads, unless it stopped and a later run exists: only the latest run of a spec resumes.
    const run = holds && holds.status === 'interrupted' && latest && latest.n > holds.n ? latest : (holds ?? latest);
    const history = own.filter((r) => r.runId !== run?.runId);
    const situation = situationOf(status, holds, latest);
    const record = run ? await readRun(runsDir(idx), run.runId) : null;
    const name = withoutCodes(spec.objectives[0]!);
    let digest: string | null = null;
    if (run) {
      const budget = Math.min(share, remaining);
      const report = await failureReport({ spec, root: row.dir, runs: runsDir(idx), run, record, holds, history, runStatuses: own.map((r) => r.status), secrets, autonomous, digestMax: budget }).catch(() => ({ digest: 'O registro desta spec não pôde ser lido agora.', detail: '' }));
      if (report.detail) details.set(spec.specId, report.detail);
      if (budget >= DIGEST_FLOOR) {
        digest = report.digest;
        remaining -= report.digest.length;
      } else digest = `Há problemas registrados, mas o espaço desta resposta acabou. Detalhes completos: falhas/${spec.specId}.md.`;
    }
    blocks.push({ name, situation, block: specBlock(spec, situation, run, record?.tasks ?? []), digest });
  }
  const problems = blocks.filter((b) => b.digest !== null).map((b) => `### Problemas: ${b.name}\n${b.digest}`);
  const problemsSection = problems.length ? [`## Problemas registrados\nFatos gravados pelas execuções. "Registro" é a mensagem original, que pode estar em inglês. Os horários estão em UTC.`, ...problems].join('\n\n') : '';
  let size = head.length + problemsSection.length;
  const kept: string[] = [];
  for (const b of blocks) {
    if (size + b.block.length > MAX_CHARS) {
      others.push(`- ${b.name}: ${b.situation} (sem detalhes por causa do tamanho)`);
      continue;
    }
    kept.push(b.block);
    size += b.block.length;
  }
  const rest = others.length ? [`### Outras specs (só o nome e a situação)\n${others.join('\n')}`] : [];
  const body = kept.length || rest.length ? [...kept, ...rest].join('\n\n') : '(o projeto ainda não tem specs)';
  return { name: project.name, text: [head, body, ...(problemsSection ? [problemsSection] : [])].join('\n\n'), details, specIds: specs.map((s) => s.specId) };
}
