import type { z } from 'zod';
import type { StepOutcome } from '../runner/step.js';

/** The list entries a schema error points at, such as `docPatch.3.reason`, grouped by list. */
function badEntries(errors: readonly string[]): Map<string, number[]> | null {
  const bad = new Map<string, number[]>();
  for (const error of errors) {
    if (error.startsWith('answer: ')) continue;
    const match = /^(\w+)\.(\d+)(?:\.|:)/.exec(error);
    if (!match) return null;
    bad.set(match[1]!, [...(bad.get(match[1]!) ?? []), Number(match[2])]);
  }
  return bad.size > 0 ? bad : null;
}

/**
 * Repairs a schema failure without asking the agent again: the list entries the errors point at are dropped, and the rest
 * of the answer stands when it then fits the schema. Null when the answer cannot be read or an error is not about a list entry.
 */
export function repairByDropping<T>(failed: Extract<StepOutcome<T>, { ok: false }>, schema: z.ZodType<T>): StepOutcome<T> | null {
  const line = failed.errors.find((e) => e.startsWith('answer: '));
  const bad = badEntries(failed.errors);
  if (!line || !bad) return null;
  let answer: Record<string, unknown>;
  try {
    answer = JSON.parse(line.slice('answer: '.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const [key, indexes] of bad) {
    if (!Array.isArray(answer[key])) return null;
    answer[key] = (answer[key] as unknown[]).filter((_, i) => !indexes.includes(i));
  }
  const parsed = schema.safeParse(answer);
  return parsed.success ? { ok: true, value: parsed.data, summary: failed.summary } : null;
}
