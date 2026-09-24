import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateAgentOutput } from '../../server/validators/agent-output.js';
import type { RefContext } from '../../server/validators/references.js';

const HASH = `sha256:${'b'.repeat(64)}`;
const Output = z.object({
  specHash: z.string(),
  status: z.enum(['done', 'spec-gap']),
  files: z.array(z.string()),
  question: z.string().optional(),
});

const refContext: RefContext = {
  acIds: new Set(),
  taskIds: new Set(),
  files: new Set(['src/a.ts']),
  tests: new Set(),
  adrIds: new Set(),
};

const opts = {
  expectedSpecHash: HASH,
  refContext,
  refs: (v: z.infer<typeof Output>) => ({ files: v.files }),
  semantic: [(v: z.infer<typeof Output>) => (v.status === 'spec-gap' && !v.question ? ['spec-gap requires a question'] : [])],
};

describe('validateAgentOutput', () => {
  it('returns the parsed value when every check passes', () => {
    const result = validateAgentOutput(Output, { specHash: HASH, status: 'done', files: ['src/a.ts'] }, opts);
    expect(result).toEqual({ ok: true, value: { specHash: HASH, status: 'done', files: ['src/a.ts'] } });
  });

  it('reports schema errors with their path and stops there', () => {
    const result = validateAgentOutput(Output, { specHash: HASH, status: 'finished', files: [] }, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^status: /);
  });

  it('rejects a specHash mismatch', () => {
    const result = validateAgentOutput(Output, { specHash: `sha256:${'c'.repeat(64)}`, status: 'done', files: [] }, opts);
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('specHash mismatch')] });
  });

  it('collects reference and semantic errors together', () => {
    const result = validateAgentOutput(Output, { specHash: HASH, status: 'spec-gap', files: ['src/ghost.ts'] }, opts);
    expect(result).toEqual({ ok: false, errors: ['unknown file: src/ghost.ts', 'spec-gap requires a question'] });
  });
});
