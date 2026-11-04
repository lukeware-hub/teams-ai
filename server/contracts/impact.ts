import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';

const text = (max: number) => z.string().min(1).max(max);
const key = z.string().regex(ID_PATTERNS.SLUG);

/** What a request does to the project that exists: what it touches, what it conflicts with, what it repeats, and its risks. */
export const Impact = z.object({
  /** The request the impact belongs to: an impact of another request is refused. */
  requestId: key,
  summary: text(600),
  affected: z.array(z.object({ kind: z.enum(['spec', 'doc', 'architecture', 'decision']), ref: text(200), effect: text(300), action: z.enum(['adjust', 'review', 'none']) })).max(100),
  conflicts: z.array(z.object({ a: key, b: key, reason: text(300), resolution: text(300) })).max(100),
  duplicates: z.array(z.object({ newKey: key, existing: key, verdict: z.enum(['reuse', 'distinct']), reason: text(300) })).max(100),
  dependencies: z.array(z.object({ from: key, to: key, reason: text(300) })).max(200),
  risks: z.array(z.object({ text: text(300), severity: z.enum(['low', 'medium', 'high']), mitigation: text(300) })).max(20),
});
export type Impact = z.infer<typeof Impact>;
