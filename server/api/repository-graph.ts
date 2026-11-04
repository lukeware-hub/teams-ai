import type { StoredEvent } from '../store/event-store.js';

const TOP_NODES = 60;
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
  topLinks: Array<{ source: string; target: string }>;
  usage: { graph: number; grep: number; none: number; recent: GraphUse[] };
}

/** The description of the project that the graph is merged with; it repeats the documents and has no file of its own. */
const DESCRIPTION_REPO = 'project-info';
/** Nodes that read their file at most this many at a time, so a big graph does not flood git. */
const LINK_BATCH = 10;

interface RawGraph {
  nodes?: Array<{ id: string; label?: string; repo?: string; source_file?: string; source_location?: string; community_name?: string; community?: number }>;
  links?: Array<{ source: string; target: string }>;
}

function emptyUsage(): GraphView['usage'] {
  return { graph: 0, grep: 0, none: 0, recent: [] };
}

/** How the agents used the code context, read from the runs' journals. */
export function graphUsage(runs: ReadonlyArray<{ runId: string; events: readonly StoredEvent[] }>): GraphView['usage'] {
  const usage = emptyUsage();
  const all: GraphUse[] = [];
  for (const run of runs) {
    for (const e of run.events) {
      if (e.type !== 'CODE_CONTEXT_USED') continue;
      const source = e.data.source === 'graph' || e.data.source === 'grep' ? e.data.source : 'none';
      usage[source] += 1;
      all.push({ runId: run.runId, taskId: String(e.data.taskId), step: String(e.data.step), source, nodes: Number(e.data.nodes ?? 0) });
    }
  }
  usage.recent = all.slice(-USAGE_ROWS).reverse();
  return usage;
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

/** A small view of the project's graph file: counts, the most connected nodes and how the agents used it. */
export function buildGraphView(raw: string | null, runs: Parameters<typeof graphUsage>[0]): GraphView {
  const usage = graphUsage(runs);
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
  if (nodes.length === 0) return { available: false, nodes: 0, links: 0, communities: 0, top: [], topLinks: [], usage };
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  const top = [...nodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, TOP_NODES)
    .map((n) => ({ id: n.id, label: n.label ?? n.id, repo: n.repo ?? '', file: n.source_file ?? '', line: lineOf(n.source_location), community: n.community_name ?? String(n.community ?? ''), edges: degree.get(n.id) ?? 0, url: null }));
  const shown = new Set(top.map((n) => n.id));
  const topLinks = links.filter((l) => shown.has(l.source) && shown.has(l.target)).map((l) => ({ source: l.source, target: l.target }));
  const communities = new Set(nodes.map((n) => n.community_name ?? n.community)).size;
  return { available: true, nodes: nodes.length, links: links.length, communities, top, topLinks, usage };
}
