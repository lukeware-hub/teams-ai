import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { armsConclusive } from '../server/api/graph-experiment.js';
import { graphUsage, type StepSpend } from '../server/api/repository-graph.js';
import type { StoredEvent } from '../server/store/event-store.js';

/** The average of a step group: cost, tool calls and file reads per step. */
export interface Average {
  steps: number;
  costUsd: number;
  toolCalls: number;
  reads: number;
  failedShare: number;
}

export interface KindReport {
  withGraph: Average;
  withoutGraph: Average;
  /** Cost per step with the graph minus without it, as a share of the without-graph cost; negative means the graph saved money. Null when either group is empty. */
  costChange: number | null;
}

/** One step kind of the graph experiment: the specs that had the graph next to the control specs that did not, with the run steps each average is over. */
export interface ExperimentReport {
  graph: Average;
  control: Average;
  /** How many different specs each arm has. */
  specs: { graph: number; control: number };
  /** False while an arm has too few steps or too few specs, and the difference below is not a result. */
  conclusive: boolean;
  /** Cost per step with the graph minus the control's, as a share of the control's; negative means the graph saved money. Null when either arm has no step. */
  costChange: number | null;
}

export interface GraphReport {
  /** The experiment by step kind; empty until runs journaled with an arm have finished steps. */
  experiment: Record<string, ExperimentReport>;
  queries: number;
  /** The queries of steps recorded with the answer figures; the shares below divide by this, since older steps recorded only the count. */
  measuredQueries: number;
  /** Queries that found something, as a share of the measured ones; null when there were none. */
  usefulShare: number | null;
  truncatedShare: number | null;
  byKind: Record<string, KindReport>;
}

const averageOf = (sum: StepSpend): Average => {
  const n = Math.max(sum.steps, 1);
  return { steps: sum.steps, costUsd: sum.costUsd / n, toolCalls: sum.toolCalls / n, reads: sum.reads / n, failedShare: sum.failed / n };
};

/** How often the agents queried the graph, how often it answered, and what the steps that used it cost next to the ones that did not. */
export function graphReport(events: readonly StoredEvent[]): GraphReport {
  // Each run counts apart, since its start says which arm it was in.
  const runs = new Map<string, StoredEvent[]>();
  for (const e of events) runs.set(e.runId, [...(runs.get(e.runId) ?? []), e]);
  const usage = graphUsage([...runs].map(([runId, own]) => ({ runId, events: own })));
  const effect = usage.effect!;
  const queries = usage.queries.total;
  const byKind: Record<string, KindReport> = {};
  for (const [kind, { withGraph, withoutGraph }] of Object.entries(effect.byKind)) {
    const [yes, no] = [averageOf(withGraph), averageOf(withoutGraph)];
    byKind[kind] = { withGraph: yes, withoutGraph: no, costChange: withGraph.steps > 0 && withoutGraph.steps > 0 && no.costUsd > 0 ? (yes.costUsd - no.costUsd) / no.costUsd : null };
  }
  const experiment: Record<string, ExperimentReport> = {};
  for (const [kind, { graph, control, specs }] of Object.entries(effect.arms)) {
    const [yes, no] = [averageOf(graph), averageOf(control)];
    experiment[kind] = { graph: yes, control: no, specs, conclusive: armsConclusive({ graph: yes.steps, control: no.steps }, specs), costChange: graph.steps > 0 && control.steps > 0 && no.costUsd > 0 ? (yes.costUsd - no.costUsd) / no.costUsd : null };
  }
  const { measured } = effect;
  return {
    experiment,
    queries,
    measuredQueries: measured,
    usefulShare: measured === 0 ? null : (measured - effect.empty) / measured,
    truncatedShare: measured === 0 ? null : effect.truncated / measured,
    byKind,
  };
}

/** Prints the graph report of each journal given (events.ndjson of a refinement draft or of a run), read together. */
async function main(files: string[]): Promise<void> {
  const events: StoredEvent[] = [];
  for (const file of files) {
    for (const line of (await fs.readFile(file, 'utf8')).split('\n')) if (line.trim() !== '') events.push(JSON.parse(line) as StoredEvent);
  }
  console.log(JSON.stringify(graphReport(events), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length < 3) throw new Error('usage: tsx scripts/graph-report.ts <events.ndjson>...');
  await main(process.argv.slice(2));
}
