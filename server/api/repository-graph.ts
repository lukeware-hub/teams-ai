import type { StoredEvent } from '../store/event-store.js';

const TOP_NODES = 60;
/** The map draws at most this many nodes, the most connected first. */
const MAP_NODES = 3000;
const MOVE_PASSES = 20;
const USAGE_ROWS = 40;

export interface GraphViewNode {
  id: string;
  label: string;
  /** The repository tag the graph gave the node. */
  repo: string;
  file: string;
  line: number | null;
  community: string;
  edges: number;
  /** The GitHub page of the file, or null when the node has no file to open. */
  url: string | null;
}

export interface GraphMapNode {
  id: string;
  label: string;
  repo: string;
  file: string;
  line: number | null;
  /** The id of the community the node belongs to. */
  community: string;
  edges: number;
}

export interface GraphCommunity {
  id: string;
  /** The label of the most connected node of the community. */
  name: string;
  size: number;
}

export interface GraphMap {
  nodes: GraphMapNode[];
  links: Array<{ source: string; target: string }>;
  communities: GraphCommunity[];
  /** True when the graph was larger than the map draws. */
  truncated: boolean;
}

/** The kinds of node the brain of a project holds. */
export interface GraphComposition {
  code: number;
  documents: number;
  tasks: number;
  runs: number;
  chat: number;
  costs: number;
}

/** Queries and the counted steps they came from, for one source of agents. */
export interface QueryCount {
  total: number;
  /** Finished agent steps that carry the count; steps recorded before it existed are not in it. */
  steps: number;
}

/**
 * What the agents asked the graph themselves. The top fields are the delivery runs (their steps by kind); the refinement
 * drafts and the chat answers are counted apart, because their agents get the graph as text and often ask nothing.
 */
export interface GraphQueries extends QueryCount {
  byKind: Record<string, number>;
  refine: QueryCount;
  chat: QueryCount;
}

/** What the finished steps of one kind spent, summed. */
export interface StepSpend {
  steps: number;
  costUsd: number;
  toolCalls: number;
  /** Read and Grep calls: the file reading the graph is meant to spare. */
  reads: number;
  failed: number;
}

/** The steps of one kind that queried the graph next to the ones that did not; only a same-kind comparison is fair. */
export interface GraphEffectOfKind {
  withGraph: StepSpend;
  withoutGraph: StepSpend;
}

/** The steps of one kind in the runs of the graph experiment: the arm that had the graph next to the control arm that did not. */
export interface GraphArms {
  graph: StepSpend;
  control: StepSpend;
  /** How many different specs each arm has: an arm is chosen per spec, so a few specs mix the effect of the graph with the size of the spec. */
  specs: { graph: number; control: number };
}

/** What the graph queries returned, and how the steps that used the graph compare with the ones that did not. */
export interface GraphEffect {
  byKind: Record<string, GraphEffectOfKind>;
  /** The experiment, by step kind: runs whose start journaled their arm. Unlike `byKind`, the arm does not depend on what the agent chose to do. */
  arms: Record<string, GraphArms>;
  /** Queries that found nothing or failed, queries the token budget cut, and the characters all queries returned. */
  empty: number;
  truncated: number;
  resultChars: number;
  /** The queries of the steps that recorded those three figures; older steps recorded only the count, so shares divide by this. */
  measured: number;
}

/** Where the counts besides the delivery runs come from: the event lists of the refinement drafts and the stored chat answers. */
export interface GraphUsageSources {
  refine?: ReadonlyArray<readonly StoredEvent[]>;
  /** One entry per stored chat answer: its graph query count, or undefined when it was not measured. */
  chat?: ReadonlyArray<number | undefined>;
}

export interface GraphUse {
  runId: string;
  taskId: string;
  step: string;
  source: string;
  nodes: number;
}

export interface GraphView {
  /** False when the project has no readable graph yet. */
  available: boolean;
  nodes: number;
  links: number;
  communities: number;
  /** The most connected nodes, and the links between them only. */
  top: GraphViewNode[];
  usage: { graph: number; grep: number; none: number; recent: GraphUse[]; queries: GraphQueries; effect?: GraphEffect };
  /** How many spec files the graph holds, so the health panel can tell a graph with no relations from a project with no specs. */
  specs?: number;
  /** How many links of each relation the project's own state and failure notes added between specs, plans, services and failures; absent when the graph holds none. */
  relations?: Record<string, number>;
  /** How many nodes of each kind the brain of the project holds: its code, its documents and the notes written from its runs and chat. */
  composition?: GraphComposition;
  /** Every node and link for the interactive map, with the communities the nodes fall into. */
  map?: GraphMap;
  /** When the graph file was last written and why the last automatic build failed; the route fills both. */
  status?: { updatedAt: string | null; failure: { at: string; message: string } | null };
}

/** The relations the graph gets from the project's saved state and from the failures of its runs, counted for the health panel. */
const RELATIONS: ReadonlySet<string> = new Set(['depends_on', 'has_plan', 'has_tasks', 'belongs_to', 'derived_from', 'touches', 'similar_failure']);

/** The links of the graph by relation, over those the specs and failures added; the description's own nodes count, since the specs sit there. */
function relationsOf(links: ReadonlyArray<{ relation?: string }>): Record<string, number> | undefined {
  const found: Record<string, number> = {};
  for (const l of links) if (l.relation && RELATIONS.has(l.relation)) found[l.relation] = (found[l.relation] ?? 0) + 1;
  return Object.keys(found).length > 0 ? found : undefined;
}

/** The page node of a spec file, in the layout of a documentation repository or the legacy one. */
const SPEC_PAGE = /(?:^|\/)(?:specify|specs)\/[^/]+\/spec\.md$/;

/** The description of the project that the graph is merged with; it repeats the documents and has no file of its own. */
const DESCRIPTION_REPO = 'project-info';
/** Nodes that read their file at most this many at a time, so a big graph does not flood git. */
const LINK_BATCH = 10;

interface RawGraph {
  nodes?: Array<{ id: string; label?: string; repo?: string; file_type?: string; node_kind?: string; source_file?: string; source_location?: string; community_name?: string; community?: number }>;
  links?: Array<{ source: string; target: string; relation?: string }>;
}

function emptyUsage(): GraphView['usage'] {
  return { graph: 0, grep: 0, none: 0, recent: [], queries: { total: 0, steps: 0, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } } };
}

const spendOf = (): StepSpend => ({ steps: 0, costUsd: 0, toolCalls: 0, reads: 0, failed: 0 });
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Adds one finished step to the effect: into its kind's with-graph or without-graph sum, and the query figures into the totals. */
function addSpend(sum: StepSpend, e: StoredEvent): void {
  const calls = (e.data.profile as { toolCalls?: Record<string, number> } | undefined)?.toolCalls ?? {};
  sum.steps += 1;
  sum.costUsd += numberOf(e.data.costUsd);
  sum.toolCalls += Object.values(calls).reduce((n, c) => n + c, 0);
  sum.reads += numberOf(calls.Read) + numberOf(calls.Grep);
  if (e.data.ok === false) sum.failed += 1;
}

/** Adds a finished step of a run in the experiment to the arm the run's start put it in. */
function addArm(effect: GraphEffect, arm: string | undefined, specId: string, seen: Map<string, Set<string>>, e: StoredEvent): void {
  if ((arm !== 'graph' && arm !== 'control') || e.type !== 'STEP_FINISHED') return;
  const kind = String(e.data.kind);
  const of = (effect.arms[kind] ??= { graph: spendOf(), control: spendOf(), specs: { graph: 0, control: 0 } });
  addSpend(of[arm], e);
  const key = `${kind}|${arm}`;
  const specs = seen.get(key) ?? new Set<string>();
  seen.set(key, specs.add(specId));
  of.specs[arm] = specs.size;
}

function addEffect(effect: GraphEffect, e: StoredEvent): void {
  const profile = e.data.profile as { graphQueries?: unknown; graphEmpty?: unknown; graphTruncated?: unknown; graphResultChars?: unknown } | undefined;
  if (e.type !== 'STEP_FINISHED' || typeof profile?.graphQueries !== 'number') return;
  const of = (effect.byKind[String(e.data.kind)] ??= { withGraph: spendOf(), withoutGraph: spendOf() });
  addSpend(profile.graphQueries > 0 ? of.withGraph : of.withoutGraph, e);
  if (typeof profile.graphEmpty === 'number') effect.measured += profile.graphQueries;
  effect.empty += numberOf(profile.graphEmpty);
  effect.truncated += numberOf(profile.graphTruncated);
  effect.resultChars += numberOf(profile.graphResultChars);
}

/** How the agents used the code context, read from the runs' journals. */
export function graphUsage(runs: ReadonlyArray<{ runId: string; events: readonly StoredEvent[] }>, sources: GraphUsageSources = {}): GraphView['usage'] {
  const usage = emptyUsage();
  const effect: GraphEffect = { byKind: {}, arms: {}, empty: 0, truncated: 0, resultChars: 0, measured: 0 };
  usage.effect = effect;
  // A finished step that carries the count; older steps have no `graphQueries` and would read as zero.
  const countOf = (e: StoredEvent): number | null => {
    const queries = (e.data.profile as { graphQueries?: unknown } | undefined)?.graphQueries;
    return e.type === 'STEP_FINISHED' && typeof queries === 'number' ? queries : null;
  };
  for (const events of sources.refine ?? []) {
    for (const e of events) {
      addEffect(effect, e);
      const n = countOf(e);
      if (n === null) continue;
      usage.queries.refine.steps += 1;
      usage.queries.refine.total += n;
    }
  }
  for (const n of sources.chat ?? []) {
    if (typeof n !== 'number') continue;
    usage.queries.chat.steps += 1;
    usage.queries.chat.total += n;
  }
  const all: GraphUse[] = [];
  const armSpecs = new Map<string, Set<string>>();
  for (const run of runs) {
    const started = run.events.find((e) => e.type === 'RUN_STARTED');
    const arm = started?.data.graphArm;
    const specId = String(started?.data.specId ?? run.runId);
    for (const e of run.events) {
      if (e.type === 'STEP_FINISHED') {
        addEffect(effect, e);
        addArm(effect, typeof arm === 'string' ? arm : undefined, specId, armSpecs, e);
        const queries = countOf(e);
        if (queries === null) continue;
        const kind = String(e.data.kind);
        usage.queries.steps += 1;
        usage.queries.total += queries;
        usage.queries.byKind[kind] = (usage.queries.byKind[kind] ?? 0) + queries;
        continue;
      }
      if (e.type !== 'CODE_CONTEXT_USED') continue;
      const source = e.data.source === 'graph' || e.data.source === 'grep' ? e.data.source : 'none';
      usage[source] += 1;
      all.push({ runId: run.runId, taskId: String(e.data.taskId), step: String(e.data.step), source, nodes: Number(e.data.nodes ?? 0) });
    }
  }
  usage.recent = all.slice(-USAGE_ROWS).reverse();
  return usage;
}

/**
 * Groups the nodes by modularity: each node starts alone and moves to the neighbouring group that tightens the groups the most, until none
 * moves. Nodes are visited in id order and ties go to the smaller group, so the same graph always gives the same groups. Nodes with no
 * link share one group. Communities come back biggest first, each named after its most connected node.
 */
export function communitiesOf(nodes: ReadonlyArray<{ id: string; label: string }>, links: ReadonlyArray<{ source: string; target: string }>): { of: Map<string, string>; list: GraphCommunity[] } {
  const order = [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1));
  const index = new Map(order.map((n, i) => [n.id, i]));
  const neighbours: number[][] = order.map(() => []);
  for (const l of links) {
    const [from, to] = [index.get(l.source), index.get(l.target)];
    if (from === undefined || to === undefined || from === to) continue;
    neighbours[from]!.push(to);
    neighbours[to]!.push(from);
  }
  const degree = neighbours.map((n) => n.length);
  const twiceLinks = degree.reduce((sum, d) => sum + d, 0);
  const group = order.map((_, i) => i);
  const total = [...degree];
  for (let pass = 0; pass < MOVE_PASSES && twiceLinks > 0; pass++) {
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      if (degree[i] === 0) continue;
      const own = group[i]!;
      total[own]! -= degree[i]!;
      const toGroup = new Map<number, number>();
      for (const other of neighbours[i]!) toGroup.set(group[other]!, (toGroup.get(group[other]!) ?? 0) + 1);
      const gain = (g: number) => (toGroup.get(g) ?? 0) - (total[g]! * degree[i]!) / twiceLinks;
      let best = own;
      for (const g of [...toGroup.keys()].sort((a, b) => a - b)) if (gain(g) > gain(best) + 1e-12) best = g;
      total[best]! += degree[i]!;
      if (best !== own) {
        group[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const groups = new Map<string, number[]>();
  order.forEach((_, i) => {
    const key = degree[i] === 0 ? 'alone' : String(group[i]);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[1][0]! - b[1][0]!);
  const of = new Map<string, string>();
  const list = ranked.map(([key, members], i) => {
    const id = `c${i + 1}`;
    for (const m of members) of.set(order[m]!.id, id);
    const top = [...members].sort((a, b) => degree[b]! - degree[a]! || a - b)[0]!;
    return { id, name: key === 'alone' ? 'Sem ligações' : order[top]!.label, size: members.length };
  });
  return { of, list };
}

const lineOf = (location: string | undefined): number | null => {
  const line = Number(/^L(\d+)/.exec(location ?? '')?.[1]);
  return line > 0 ? line : null;
};

/** The view with each most-connected node's file page filled in by `resolve`; a node that fails to resolve keeps no link. */
export async function linkNodes(view: GraphView, resolve: (node: GraphViewNode) => Promise<string | null>): Promise<GraphView> {
  const top: GraphViewNode[] = [];
  for (let i = 0; i < view.top.length; i += LINK_BATCH) {
    top.push(...(await Promise.all(view.top.slice(i, i + LINK_BATCH).map(async (n) => ({ ...n, url: await resolve(n).catch(() => null) })))));
  }
  return { ...view, top };
}

/** What a node is, from the note it comes from or its file type; the notes of the brain live under `brain/`. */
function compositionOf(nodes: ReadonlyArray<{ file_type?: string; source_file?: string }>): GraphComposition {
  const count: GraphComposition = { code: 0, documents: 0, tasks: 0, runs: 0, chat: 0, costs: 0 };
  for (const n of nodes) {
    const file = n.source_file ?? '';
    if (file.startsWith('brain/tasks/')) count.tasks += 1;
    else if (file.startsWith('brain/runs/')) count.runs += 1;
    else if (file === 'brain/chat.md') count.chat += 1;
    else if (file === 'brain/costs.md') count.costs += 1;
    else if (n.file_type === 'document') count.documents += 1;
    else count.code += 1;
  }
  return count;
}

/** A small view of the project's graph file: counts, the most connected nodes and how the agents used it. */
export function buildGraphView(raw: string | null, runs: Parameters<typeof graphUsage>[0], sources: GraphUsageSources = {}): GraphView {
  const usage = graphUsage(runs, sources);
  let graph: RawGraph = {};
  try {
    graph = raw ? (JSON.parse(raw) as RawGraph) : {};
  } catch {
    graph = {};
  }
  const all = graph.nodes ?? [];
  const nodes = all.filter((n) => n.repo !== DESCRIPTION_REPO);
  const kept = new Set(nodes.map((n) => n.id));
  const links = (graph.links ?? []).filter((l) => kept.has(l.source) && kept.has(l.target));
  if (nodes.length === 0) return { available: false, nodes: 0, links: 0, communities: 0, top: [], usage };
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  const groups = communitiesOf(nodes.map((n) => ({ id: n.id, label: n.label ?? n.id })), links);
  const byDegree = [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
  const mapNode = (n: (typeof nodes)[number]): GraphMapNode => ({ id: n.id, label: n.label ?? n.id, repo: n.repo ?? '', file: n.source_file ?? '', line: lineOf(n.source_location), community: groups.of.get(n.id)!, edges: degree.get(n.id) ?? 0 });
  const top = byDegree.slice(0, TOP_NODES).map((n) => ({ ...mapNode(n), url: null }));
  const drawn = byDegree.slice(0, MAP_NODES);
  const shown = new Set(drawn.map((n) => n.id));
  const map: GraphMap = {
    nodes: drawn.map(mapNode),
    links: links.filter((l) => shown.has(l.source) && shown.has(l.target)).map((l) => ({ source: l.source, target: l.target })),
    communities: groups.list,
    truncated: nodes.length > MAP_NODES,
  };
  const relations = relationsOf(graph.links ?? []);
  const specs = all.filter((n) => n.node_kind === 'page' && SPEC_PAGE.test(n.source_file ?? '')).length;
  return { available: true, nodes: nodes.length, links: links.length, communities: groups.list.length, top, usage, map, composition: compositionOf(nodes), specs, ...(relations ? { relations } : {}) };
}
