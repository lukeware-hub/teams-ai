import { promises as fs } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../core/redact.js';
import type { StoredEvent } from '../store/event-store.js';
import { loadEvents } from '../store/event-store.js';
import { bySpec, type RunJournal } from './brain-notes.js';
import { editGraphFile } from './graph-file.js';

/** A run that ended without delivering: the ones that ended in these results. */
const FAILED_RESULTS: ReadonlySet<string> = new Set(['phase-failed', 'blocked', 'deadlocked', 'verification-failed', 'deploy-failed']);
/** A run that ended delivering, which settles the failures of the runs before it. */
const DELIVERED_RESULTS: ReadonlySet<string> = new Set(['complete', 'awaiting-validation', 'done']);
const REASON_MAX = 200;
const OWN_MAX = 2;
const OTHERS_MAX = 5;

/** One run of a spec that ended without delivering, why, and the later run that delivered, when there is one. */
export interface Failure {
  specId: string;
  runNo: number;
  result: string;
  reason: string;
  /** The reason without what changes from run to run (paths, ids, numbers), so the same cause reads the same. */
  signature: string;
  fixedInRun?: number;
  /** The ids of those runs, as the owner sees them (the position above only matches the headings of the notes). */
  runId: string;
  fixedByRunId?: string;
}

/** The short name of a run, the part of its id after the project and the spec. */
const runName = (runId: string): string => runId.split('--').pop() ?? runId;

/** A reason with its paths, links, ids and numbers replaced by a word, so two runs that failed the same way share a signature. */
export function failureSignature(reason: string): string {
  return reason
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w@.-]*\/[\w@./-]+|\b[\w-]+\.(?:md|json|go|ts|tsx|js|sql|ya?ml)\b/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A blocked task that only waited for another one says nothing about the cause. */
const WAITED = /^a dependency is blocked/;

/** The blocked tasks of a finished run that blocked on their own, each with its reason; the first two, since the run's own reason is empty when tasks blocked it. */
function blockedReason(finished: StoredEvent | undefined): string {
  const blocked = Array.isArray(finished?.data.blocked) ? (finished!.data.blocked as Array<Record<string, unknown>>) : [];
  return blocked
    .filter((b) => !WAITED.test(text(b.reason)))
    .slice(0, 2)
    .map((b) => `${text(b.taskId)}: ${text(b.reason)}`)
    .join('; ');
}

/** The reason a run ended without delivering: the one it finished with, else what its blocked tasks say, else the last phase that failed. */
function reasonOf(events: readonly StoredEvent[]): string {
  const finished = [...events].reverse().find((e) => e.type === 'RUN_FINISHED');
  const phase = [...events].reverse().find((e) => e.type === 'PHASE_FAILED');
  return text(finished?.data.reason) || blockedReason(finished) || text(phase?.data.reason);
}

/** Every run that ended without delivering, by spec and run number, with the later run that delivered the spec. */
export function failuresOf(runs: readonly RunJournal[]): Failure[] {
  const out: Failure[] = [];
  for (const spec of bySpec(runs)) {
    spec.runs.forEach((run, i) => {
      const result = text([...run.events].reverse().find((e) => e.type === 'RUN_FINISHED')?.data.result);
      // A reason can quote a command or a log, so a secret in it is masked before it reaches a brief or a note.
      const reason = redactSecrets(reasonOf(run.events)).replace(/\s+/g, ' ').trim();
      if (!FAILED_RESULTS.has(result) || reason === '') return;
      const later = spec.runs.findIndex((r, j) => j > i && DELIVERED_RESULTS.has(text([...r.events].reverse().find((e) => e.type === 'RUN_FINISHED')?.data.result)));
      out.push({ specId: spec.specId, runNo: i + 1, runId: run.runId, result, reason: reason.slice(0, REASON_MAX), signature: failureSignature(reason), ...(later >= 0 ? { fixedInRun: later + 1, fixedByRunId: spec.runs[later]!.runId } : {}) });
    });
  }
  return out;
}

/**
 * The lines of a spec's brief about failures: its own last ones and whether a later run settled them, and the other specs the same cause hit.
 * A run that failed in its phases (the repository, the documents) failed on the platform, not on the code the agents write, so it is left out.
 */
export function failureLines(failures: readonly Failure[], specId: string): string[] {
  const own = failures.filter((f) => f.specId === specId && f.result !== 'phase-failed');
  if (own.length === 0) return [];
  const lines = own.slice(-OWN_MAX).map((f) => `- Earlier failure of this spec (${runName(f.runId)}, ${f.result}): ${f.reason} — ${f.fixedByRunId ? `a later run delivered it (${runName(f.fixedByRunId)})` : 'not delivered since'}`);
  const signatures = new Set(own.map((f) => f.signature));
  const others = [...new Set(failures.filter((f) => f.specId !== specId && signatures.has(f.signature)).map((f) => f.specId))];
  if (others.length > 0) lines.push(`- The same cause stopped: ${others.slice(0, OTHERS_MAX).join(', ')}${others.length > OTHERS_MAX ? ` and ${others.length - OTHERS_MAX} more` : ''}`);
  return lines;
}

/** The journals of a project's runs, read from the runs folder (runs are named `<project>--<spec>--run-<n>`); an unreadable journal gives none. */
export async function readRunJournals(runsDir: string, projectId: string): Promise<RunJournal[]> {
  const names = (await fs.readdir(runsDir).catch(() => [] as string[])).filter((n) => n.startsWith(`${projectId}--`));
  return Promise.all(names.map(async (runId) => ({ runId, events: await loadEvents(path.join(runsDir, runId, 'events.ndjson')).catch(() => [] as StoredEvent[]) })));
}

/** Two run headings of the notes whose failures share a cause: the later one and the first one that had it. */
export interface FailureLink {
  fromFile: string;
  fromHeading: string;
  toFile: string;
  toHeading: string;
}

const noteOf = (failure: Failure): { file: string; heading: string } => ({ file: `brain/runs/${failure.specId}.md`, heading: `Execução ${failure.runNo} — ${failure.result}` });

/** Each failure linked to the first failure of another spec with the same cause, so a cause is one chain and not a clique. */
export function failureLinks(failures: readonly Failure[]): FailureLink[] {
  const first = new Map<string, Failure>();
  const links: FailureLink[] = [];
  for (const failure of failures) {
    const origin = first.get(failure.signature);
    if (!origin) first.set(failure.signature, failure);
    else if (origin.specId !== failure.specId) {
      const [from, to] = [noteOf(failure), noteOf(origin)];
      links.push({ fromFile: from.file, fromHeading: from.heading, toFile: to.file, toHeading: to.heading });
    }
  }
  return links;
}

interface RawNode {
  id: string;
  label?: string;
  source_file?: string;
}
interface RawGraph {
  nodes?: RawNode[];
  links?: Array<{ source: string; target: string; relation?: string }>;
}

/** Adds a `similar_failure` edge for each link whose two headings are in the graph; an edge already there is not added again. */
export function linkFailures<G extends RawGraph>(graph: G, wanted: readonly FailureLink[]): { graph: G; added: number } {
  const nodes = graph.nodes ?? [];
  const links = [...(graph.links ?? [])];
  const seen = new Set(links.map((l) => `${l.source}|${l.target}|${l.relation ?? ''}`));
  const heading = (file: string, label: string): RawNode | undefined => nodes.find((n) => n.source_file === file && n.label === label);
  let added = 0;
  for (const want of wanted) {
    const [from, to] = [heading(want.fromFile, want.fromHeading), heading(want.toFile, want.toHeading)];
    if (!from || !to || from.id === to.id) continue;
    const key = `${from.id}|${to.id}|similar_failure`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: from.id, target: to.id, relation: 'similar_failure', confidence: 'INFERRED', weight: 1, source_file: want.fromFile, _origin: 'failures' } as RawGraph['links'] extends Array<infer L> ? L : never);
    added += 1;
  }
  return { graph: { ...graph, links }, added };
}

/** Adds the failure edges to the graph file in place; a file that cannot be read or parsed is left as it is. */
export async function linkFailuresFile(graphFile: string, wanted: readonly FailureLink[]): Promise<number> {
  if (wanted.length === 0) return 0;
  return editGraphFile<RawGraph>(graphFile, (graph) => linkFailures(graph, wanted));
}
