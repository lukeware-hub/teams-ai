import type { ChatMessage } from '../chat/store.js';
import { redactSecrets } from '../core/redact.js';
import type { MainDoc } from '../git/main-docs.js';
import type { StoredEvent } from '../store/event-store.js';

/** The caps that keep the notes, and so the graph, small however long the project has lived. */
export const NOTE_LIMITS = { specs: 100, tasksPerSpec: 200, runsPerSpec: 60, chatMessages: 500, line: 400, paragraph: 700, files: 40 } as const;

/** One run of a project: its id and the events of its journal. */
export interface RunJournal {
  runId: string;
  events: readonly StoredEvent[];
}

/** A task note heading and a file it names, so the graph can link the two once the graph has the file. */
export interface BrainLink {
  /** The note file the heading is in, as the graph knows it. */
  noteFile: string;
  heading: string;
  /** A path inside a repository of the project. */
  path: string;
}

export interface Brain {
  docs: MainDoc[];
  links: BrainLink[];
}

const NOTES = 'brain';
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One short line of untrusted text: no secret, no line break and no Markdown heading mark, cut at `max`. */
const oneLine = (value: unknown, max: number = NOTE_LIMITS.line): string => {
  const text = redactSecrets(typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {});

/** A path that is safe to name in a note: relative, no `..`, no backtick. */
const safePath = (p: string): boolean => p !== '' && !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('`') && !/\s/.test(p);

export interface SpecRuns {
  specId: string;
  runs: Array<{ runId: string; at: string; events: readonly StoredEvent[] }>;
}

/** The runs grouped by spec, oldest first, from each journal's RUN_STARTED. A journal with no spec is left out. */
export function bySpec(runs: readonly RunJournal[]): SpecRuns[] {
  const groups = new Map<string, SpecRuns['runs']>();
  for (const run of runs) {
    const started = run.events.find((e) => e.type === 'RUN_STARTED');
    const specId = str(started?.data.specId);
    if (!SAFE.test(specId)) continue;
    groups.set(specId, [...(groups.get(specId) ?? []), { runId: run.runId, at: started?.at ?? '', events: run.events }]);
  }
  return [...groups.entries()]
    .map(([specId, list]) => ({ specId, runs: list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.runId < b.runId ? -1 : 1)) }))
    .sort((a, b) => (a.specId < b.specId ? -1 : 1))
    .slice(0, NOTE_LIMITS.specs);
}

interface TaskNote {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  files: Set<string>;
  state: string;
  runs: number;
}

/** The tasks of a spec: what was last planned, the files the task named or changed, and the state it ended in. */
function tasksOf(spec: SpecRuns): TaskNote[] {
  const tasks = new Map<string, TaskNote>();
  for (const run of spec.runs) {
    const seen = new Set<string>();
    for (const e of run.events) {
      if (e.type === 'TASK_PLANNED') {
        const t = record(e.data.task);
        const id = str(t.id);
        if (!SAFE.test(id)) continue;
        const note = tasks.get(id) ?? { id, title: '', description: '', criteria: [], files: new Set<string>(), state: 'planejada', runs: 0 };
        note.title = oneLine(t.title);
        note.description = oneLine(t.description, NOTE_LIMITS.paragraph);
        note.criteria = strings(t.criteriaRefs).filter((c) => SAFE.test(c));
        for (const f of strings(t.affectedPaths)) if (safePath(f)) note.files.add(f);
        if (!seen.has(id)) note.runs += 1;
        seen.add(id);
        tasks.set(id, note);
      } else if (e.type === 'TASK_STATE_CHANGED') {
        const note = tasks.get(str(e.data.taskId));
        if (note) note.state = oneLine(e.data.to, 40);
      } else if (e.type === 'DEV_COMMITTED') {
        const note = tasks.get(str(e.data.taskId));
        if (note) for (const f of strings(e.data.changedFiles)) if (safePath(f)) note.files.add(f);
      }
    }
  }
  return [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, NOTE_LIMITS.tasksPerSpec);
}

function taskNote(spec: SpecRuns): { doc: MainDoc; links: BrainLink[] } | null {
  const tasks = tasksOf(spec);
  if (tasks.length === 0) return null;
  const file = `${NOTES}/tasks/${spec.specId}.md`;
  const links: BrainLink[] = [];
  const sections = tasks.map((t) => {
    const heading = `${t.id} — ${t.title || t.id}`;
    const files = [...t.files].sort().slice(0, NOTE_LIMITS.files);
    for (const f of files) links.push({ noteFile: file, heading, path: f });
    return [
      `## ${heading}`,
      `Estado: ${t.state}. Execuções: ${t.runs}.`,
      t.description,
      ...(t.criteria.length ? ['### Critérios', ...t.criteria.map((c) => `- ${c}`)] : []),
      ...(files.length ? ['### Arquivos', ...files.map((f) => `- \`${f}\``)] : []),
    ]
      .filter((l) => l !== '')
      .join('\n');
  });
  return { doc: { file, text: `# Tarefas da spec ${spec.specId}\n\n${sections.join('\n\n')}\n` }, links };
}

/** What one run says about how it ended: the result, the tasks it blocked, the checks it failed. */
function runSection(n: number, run: SpecRuns['runs'][number]): string {
  const lines: string[] = [];
  const finished = [...run.events].reverse().find((e) => e.type === 'RUN_FINISHED');
  lines.push(`## Execução ${n} — ${oneLine(finished?.data.result ?? 'sem fim registrado', 60)}`);
  const reason = oneLine(finished?.data.reason, NOTE_LIMITS.paragraph);
  if (reason) lines.push(`Motivo: ${reason}`);
  const blocked = Array.isArray(finished?.data.blocked) ? (finished!.data.blocked as unknown[]).map(record) : [];
  if (blocked.length) lines.push('### Tarefas bloqueadas', ...blocked.slice(0, 20).map((b) => `- ${oneLine(b.taskId, 80)}: ${oneLine(b.reason)}`));
  const phase = run.events.filter((e) => e.type === 'PHASE_FAILED').slice(-3);
  if (phase.length) lines.push('### Fases que falharam', ...phase.map((e) => `- fase ${oneLine(e.data.phase, 20)}: ${oneLine(e.data.reason)}`));
  const verification = run.events.filter((e) => e.type === 'VERIFICATION_FAILED').slice(-1)[0];
  const uncovered = strings(verification?.data.uncoveredAcs);
  if (uncovered.length) lines.push('### Verificação', `Critérios sem teste que passe: ${uncovered.slice(0, 30).join(', ')}`);
  const deploy = run.events.filter((e) => e.type === 'DEPLOY_FAILED').slice(-3);
  if (deploy.length) lines.push('### Falhas de publicação', ...deploy.map((e) => `- etapa ${oneLine(e.data.stage, 30)}: ${oneLine(e.data.detail)}`));
  const gates = run.events.filter((e) => e.type === 'GATE_FAILED').length;
  if (gates) lines.push(`Gates que falharam: ${gates}.`);
  return lines.join('\n');
}

function runNote(spec: SpecRuns): MainDoc {
  const kept = spec.runs.slice(-NOTE_LIMITS.runsPerSpec);
  const offset = spec.runs.length - kept.length;
  return { file: `${NOTES}/runs/${spec.specId}.md`, text: `# Execuções da spec ${spec.specId}\n\n${kept.map((r, i) => runSection(offset + i + 1, r)).join('\n\n')}\n` };
}

/** Cost and steps of a spec, read from the finished steps of its runs. */
function costNote(specs: readonly SpecRuns[]): MainDoc | null {
  const sections = specs.flatMap((spec) => {
    let cost = 0;
    let tokens = 0;
    const kinds = new Map<string, number>();
    for (const run of spec.runs) {
      for (const e of run.events) {
        if (e.type !== 'STEP_FINISHED') continue;
        const usage = record(e.data.usage);
        cost += typeof e.data.costUsd === 'number' ? e.data.costUsd : 0;
        tokens += ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((n, k) => n + (typeof usage[k] === 'number' ? (usage[k] as number) : 0), 0);
        kinds.set(str(e.data.kind), (kinds.get(str(e.data.kind)) ?? 0) + 1);
      }
    }
    if (kinds.size === 0) return [];
    const steps = [...kinds.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${oneLine(k, 40)} ${n}`).join(', ');
    return [`## Custo da spec ${spec.specId}\nCusto estimado US$ ${cost.toFixed(4)}. Tokens: ${tokens}. Passos por tipo: ${steps}.`];
  });
  return sections.length ? { file: `${NOTES}/costs.md`, text: `# Custos por spec\n\n${sections.join('\n\n')}\n` } : null;
}

/** Question and answer pairs, oldest first; only the last `NOTE_LIMITS.chatMessages` messages. */
function chatNote(messages: readonly ChatMessage[]): MainDoc | null {
  const kept = messages.slice(-NOTE_LIMITS.chatMessages);
  const pairs: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const q = kept[i]!;
    if (q.role !== 'user') continue;
    const a = kept[i + 1]?.role === 'assistant' ? kept[i + 1]! : null;
    pairs.push([`## ${oneLine(q.text, 100)}`, `Pergunta: ${oneLine(q.text, NOTE_LIMITS.paragraph)}`, ...(a ? [`Resposta: ${oneLine(a.text, NOTE_LIMITS.paragraph)}`] : [])].join('\n'));
  }
  return pairs.length ? { file: `${NOTES}/chat.md`, text: `# Conversa do chat\n\n${pairs.join('\n\n')}\n` } : null;
}

/**
 * The notes the brain of a project holds besides its code and documents: the tasks with their criteria and files, the history
 * and failures of each run, the cost of each spec and, when the project is not confidential, the chat. `chat` is null for a
 * confidential project. The output is ordered and capped, so the same journals always give the same notes.
 */
export function brainNotes(input: { runs: readonly RunJournal[]; chat: readonly ChatMessage[] | null }): Brain {
  const specs = bySpec(input.runs);
  const docs: MainDoc[] = [];
  const links: BrainLink[] = [];
  for (const spec of specs) {
    const tasks = taskNote(spec);
    if (tasks) {
      docs.push(tasks.doc);
      links.push(...tasks.links);
    }
    docs.push(runNote(spec));
  }
  const costs = costNote(specs);
  if (costs) docs.push(costs);
  const chat = input.chat ? chatNote(input.chat) : null;
  if (chat) docs.push(chat);
  return { docs, links };
}
