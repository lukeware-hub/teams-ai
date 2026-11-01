import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';

/** The target project's five docs, by their file names under `docs/` (backlog mode keeps the briefing in `docs/briefing.md`). */
export const BACKLOG_DOCS = ['project.md', 'briefing.md', 'stack.md', 'flow.md', 'design.md'] as const;
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

const slug = z.string().regex(ID_PATTERNS.SLUG).max(40);

export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

/** Where in the docs a backlog item comes from: the traceability the human reviews and a later sync compares. */
export const BacklogSource = z.object({ doc: z.enum(BACKLOG_DOCS), heading: z.string().min(1) });

export const BacklogEpic = z.object({ key: slug, title: z.string().min(1) });

export const BacklogItem = z.object({
  /** Stable across evaluations: the id of the spec this item becomes is derived from it. */
  key: slug,
  title: z.string().min(1),
  epic: slug,
  scope: z.string().min(1),
  priority: Priority,
  rationale: z.string().min(1),
  dependsOn: z.array(slug),
  sources: z.array(BacklogSource).min(1),
  size: z.enum(['S', 'M', 'L']),
  /** The repository the item's spec changes: set by a stamped draft, from its architecture; absent before it. */
  repository: slug.optional(),
});
export type BacklogItem = z.infer<typeof BacklogItem>;

export const Backlog = z.object({ epics: z.array(BacklogEpic).min(1), items: z.array(BacklogItem).min(1) });
export type Backlog = z.infer<typeof Backlog>;
