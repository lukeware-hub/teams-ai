import path from 'node:path';
import type { Workspace } from '../orchestrator/workspace.js';
import { listState, readState } from '../docs/project-state.js';
import { editGraphFile } from './graph-file.js';

/** What the project's saved state says about one spec: who it needs, where it lives, what it came from and which files its plan changes. */
export interface RelationSpec {
  specId: string;
  repository?: string;
  dependsOn: readonly string[];
  sources: ReadonlyArray<{ doc: string; heading: string }>;
  paths: readonly string[];
}

interface RawNode {
  id: string;
  label?: string;
  source_file?: string;
  node_kind?: string;
}

interface RawLink {
  source: string;
  target: string;
  relation?: string;
}

interface RawGraph {
  nodes?: RawNode[];
  links?: RawLink[];
}

/** The most file nodes one path may link to; the same path in several repositories is rare, and a long list is a guess. */
const MAX_FILE_MATCHES = 3;
const SPEC_FILE = /(?:^|\/)(?:specify|specs)\/([^/]+)\/(spec|plan|task)\.md$/;
const SERVICES_FILE = 'projeto.md';

/**
 * Adds the edges the project's saved state already states, so the graph says how the specs relate and a question about one spec reaches
 * the rest: `depends_on` (spec to spec), `has_plan` and `has_tasks` (spec to its plan and task list), `belongs_to` (spec to its service),
 * `derived_from` (spec to the document heading it came from) and `touches` (plan to the code files its tasks change). An edge whose
 * two ends are not both in the graph adds nothing.
 */
export function linkRelations<G extends RawGraph>(graph: G, specs: readonly RelationSpec[]): { graph: G; added: number } {
  const nodes = graph.nodes ?? [];
  const links = [...(graph.links ?? [])];
  const seen = new Set(links.map((l) => `${l.source}|${l.target}|${l.relation ?? ''}`));
  const byFile = new Map<string, RawNode[]>();
  const pages = new Map<string, RawNode>();
  for (const n of nodes) {
    if (!n.source_file) continue;
    byFile.set(n.source_file, [...(byFile.get(n.source_file) ?? []), n]);
    const m = n.node_kind === 'page' ? n.source_file.match(SPEC_FILE) : null;
    if (m) pages.set(`${m[1]}/${m[2]}`, n);
  }
  let added = 0;
  const link = (from: RawNode | undefined, to: RawNode | undefined, relation: string): void => {
    if (!from || !to || from.id === to.id) return;
    const key = `${from.id}|${to.id}|${relation}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: from.id, target: to.id, relation, confidence: 'EXTRACTED', weight: 1, source_file: from.source_file, _origin: 'relations' } as RawLink);
    added += 1;
  };
  const heading = (docFile: string, text: string): RawNode | undefined => [docFile, `docs/${docFile}`].flatMap((f) => byFile.get(f) ?? []).find((n) => n.label?.trim() === text.trim());
  for (const spec of specs) {
    const page = pages.get(`${spec.specId}/spec`);
    link(page, pages.get(`${spec.specId}/plan`), 'has_plan');
    link(page, pages.get(`${spec.specId}/task`), 'has_tasks');
    for (const need of spec.dependsOn) link(page, pages.get(`${need}/spec`), 'depends_on');
    if (spec.repository) link(page, (byFile.get(SERVICES_FILE) ?? []).find((n) => n.label?.trim() === spec.repository), 'belongs_to');
    for (const source of spec.sources) link(page, heading(source.doc, source.heading), 'derived_from');
    for (const file of spec.paths) {
      const name = path.posix.basename(file);
      for (const target of (byFile.get(file) ?? []).filter((n) => (n.label ?? '').endsWith(name)).slice(0, MAX_FILE_MATCHES)) link(pages.get(`${spec.specId}/plan`), target, 'touches');
    }
  }
  return { graph: { ...graph, links }, added };
}

/** Adds the relations to the graph file in place; a file that cannot be read or parsed is left as it is. */
export async function linkRelationsFile(graphFile: string, specs: readonly RelationSpec[]): Promise<number> {
  if (specs.length === 0) return 0;
  return editGraphFile<RawGraph>(graphFile, (graph) => linkRelations(graph, specs));
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** One backlog entry as the saved state and the refinement hold it: what the relations are made from. */
export interface BacklogEntry {
  specId: string;
  key?: string;
  repository?: string;
  dependsOn?: readonly string[];
  sources?: ReadonlyArray<{ doc: string; heading: string }>;
}

/** The specs of a backlog, with no files yet; a dependency names a backlog key, and a key is not always the id of its spec. */
export function relationSpecsOfBacklog(entries: readonly BacklogEntry[]): RelationSpec[] {
  const idOfKey = new Map(entries.map((e) => [e.key ?? e.specId, e.specId]));
  return entries.map((e) => ({
    specId: e.specId,
    ...(e.repository ? { repository: e.repository } : {}),
    dependsOn: (e.dependsOn ?? []).map((key) => idOfKey.get(key) ?? key),
    sources: e.sources ?? [],
    paths: [],
  }));
}

/** The specs the project's saved state lists (the backlog, and each spec's plan for the files it changes); none for a project with no saved state. */
export async function readRelationSpecs(ws: Pick<Workspace, 'root'>): Promise<RelationSpec[]> {
  const backlog = (await readState(ws, 'specs.json')) as { specs?: Array<Record<string, unknown>> } | undefined;
  const items = Array.isArray(backlog?.specs) ? backlog.specs : [];
  const entries = items.flatMap((item): BacklogEntry[] =>
    typeof item.specId === 'string'
      ? [{
          specId: item.specId,
          ...(typeof item.key === 'string' ? { key: item.key } : {}),
          ...(typeof item.repository === 'string' ? { repository: item.repository } : {}),
          dependsOn: strings(item.dependsOn),
          sources: Array.isArray(item.sources) ? item.sources.filter((s): s is { doc: string; heading: string } => typeof s?.doc === 'string' && typeof s?.heading === 'string') : [],
        }]
      : [],
  );
  const planned = new Set(await listState(ws, 'specs'));
  return Promise.all(
    relationSpecsOfBacklog(entries).map(async (spec) => {
      const plan = planned.has(spec.specId) ? ((await readState(ws, `specs/${spec.specId}/plan.json`)) as { tasks?: Array<{ affectedPaths?: unknown }> } | undefined) : undefined;
      return { ...spec, paths: [...new Set((plan?.tasks ?? []).flatMap((t) => strings(t.affectedPaths)))] };
    }),
  );
}
