import type { RelationSpec } from './relation-links.js';

/** The longest brief, in characters: it rides in every step of the spec, so it stays short. */
export const BRIEF_MAX_CHARS = 1800;
const LIST_MAX = 8;
const PATHS_MAX = 12;

const list = (items: readonly string[], max: number): string => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/**
 * What the graph's relations say about one spec, as a few lines a step reads before it plans or edits: the service, the specs it needs, the
 * specs that need it, its neighbours in the service, the documents it came from and the files its plan changes. Empty when the spec is unknown
 * or has none of these and nothing else to add. `extra` is more lines about the spec, such as its earlier failures. It reads the same list the graph's edges are made from, so the brief and the graph never disagree.
 */
export function specBrief(specs: readonly RelationSpec[], specId: string, maxChars = BRIEF_MAX_CHARS, extra: readonly string[] = []): string {
  const spec = specs.find((s) => s.specId === specId);
  const cap = (lines: readonly string[]): string => {
    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  };
  if (!spec) return cap(extra);
  const consumers = specs.filter((s) => s.dependsOn.includes(specId)).map((s) => s.specId);
  const neighbours = spec.repository ? specs.filter((s) => s.repository === spec.repository && s.specId !== specId).map((s) => s.specId) : [];
  const lines = [
    spec.repository ? `- Service: ${spec.repository}` : null,
    spec.dependsOn.length ? `- Needs (finish these first): ${list(spec.dependsOn, LIST_MAX)}` : null,
    consumers.length ? `- Needed by (do not break their contract): ${list(consumers, LIST_MAX)}` : null,
    neighbours.length ? `- Other specs of this service: ${list(neighbours, LIST_MAX)}` : null,
    spec.sources.length ? `- Comes from: ${list(spec.sources.map((s) => `${s.doc} › ${s.heading}`), LIST_MAX)}` : null,
    spec.paths.length ? `- Files the plan changes: ${list(spec.paths, PATHS_MAX)}` : null,
  ].filter((l): l is string => l !== null);
  return cap([...lines, ...extra]);
}
