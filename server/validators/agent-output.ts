import type { z } from 'zod';
import { unresolvedReferences, type RefContext, type References } from './references.js';
import type { Validation } from './result.js';

export interface OutputCheckOptions<T> {
  expectedSpecHash: string;
  refs?: (value: T) => References;
  refContext?: RefContext;
  semantic?: ReadonlyArray<(value: T) => string[]>;
}

export function validateAgentOutput<T extends { specHash: string }>(
  schema: z.ZodType<T>,
  raw: unknown,
  opts: OutputCheckOptions<T>,
): Validation<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];
  if (value.specHash !== opts.expectedSpecHash) {
    errors.push(`specHash mismatch: expected ${opts.expectedSpecHash}, got ${value.specHash}`);
  }
  if (opts.refs && opts.refContext) {
    errors.push(...unresolvedReferences(opts.refs(value), opts.refContext));
  }
  for (const check of opts.semantic ?? []) errors.push(...check(value));
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
