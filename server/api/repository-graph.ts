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
  usage: { graph: number; grep: number; none: number; recent: GraphUse[]; queries: GraphQueries };
  /** How many nodes of each kind the brain of the project holds: its code, its documents and the notes written from its runs and chat. */
  composition?: GraphComposition;
  /** Every node and link for the interactive map, with the communities the nodes fall into. */
  map?: GraphMap;
  /** When the graph file was last written and why the last automatic build failed; the route fills both. */
  status?: { updatedAt: string | null; failure: { at: string; message: string } | null };
}

/** The description of the project that the graph is merged with; it repeats the documents and has no file of its own. */
const DESCRIPTION_REPO = 'project-info';
/** Nodes that read their file at most this many at a time, so a big graph does not flood git. */
const LINK_BATCH = 10;

interface RawGraph {
  nodes?: Array<{ id: string; label?: string; repo?: string; file_type?: string; source_file?: string; source_location?: string; community_name?: string; community?: number }>;
  links?: Array<{ source: string; target: string }>;
}

function emptyUsage(): GraphView['usage'] {
  return { graph: 0, grep: 0, none: 0, recent: [], queries: { total: 0, steps: 0, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } } };
}

/** How the agents used the code context, read from the runs' journals. */
export function graphUsage(runs: ReadonlyArray<{ runId: string; events: readonly StoredEvent[] }>, sources: GraphUsageSources = {}): GraphView['usage'] {
  const usage = emptyUsage();
  // A finished step that carries the count; older steps have no `graphQueries` and would read as zero.
  const countOf = (e: StoredEvent): number | null => {
    const queries = (e.data.profile as { graphQueries?: unknown } | undefined)?.graphQueries;
    return e.type === 'STEP_FINISHED' && typeof queries === 'number' ? queries : null;
  };
  for (const events of sources.refine ?? []) {
    for (const e of events) {
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
  for (const run of runs) {
    for (const e of run.events) {
      if (e.type === 'STEP_FINISHED') {
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
  return { available: true, nodes: nodes.length, links: links.length, communities: groups.list.length, top, usage, map, composition: compositionOf(nodes) };
}
