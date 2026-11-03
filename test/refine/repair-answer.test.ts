import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { repairByDropping } from '../../server/refine/repair-answer.js';

const Schema = z.object({ specHash: z.string(), docPatch: z.array(z.object({ find: z.string(), reason: z.string() })), questions: z.array(z.object({ text: z.string() })) });
type Out = z.infer<typeof Schema>;
const summary = {} as never;
const failed = (answer: unknown, errors: string[]) => ({ ok: false as const, failure: 'schema' as const, errors: [...errors, `answer: ${JSON.stringify(answer)}`], summary, sandboxDisabled: false });

describe('repairByDropping', () => {
  it('drops the list entry the error names and keeps the rest of the answer', () => {
    const answer = { specHash: 'h', docPatch: [{ find: 'a', reason: 'r' }, { find: 'b' }], questions: [{ text: 'q' }] };
    const out = repairByDropping<Out>(failed(answer, ['docPatch.1.reason: Required']), Schema);
    expect(out).toMatchObject({ ok: true, value: { docPatch: [{ find: 'a', reason: 'r' }], questions: [{ text: 'q' }] } });
  });

  it('gives up when an error is not about a list entry', () => {
    expect(repairByDropping<Out>(failed({ specHash: 'h' }, ['specHash: Required']), Schema)).toBeNull();
  });

  it('gives up when the answer is cut and cannot be read', () => {
    const cut = { ok: false as const, failure: 'schema' as const, errors: ['docPatch.0.reason: Required', 'answer: {"specHash":"h","docPa'], summary, sandboxDisabled: false };
    expect(repairByDropping<Out>(cut, Schema)).toBeNull();
  });

  it('gives up when the answer still does not fit after the drop', () => {
    const answer = { docPatch: [{ find: 'b' }], questions: [] };
    expect(repairByDropping<Out>(failed(answer, ['docPatch.0.reason: Required']), Schema)).toBeNull();
  });
});

describe('a stage review with one bad suggestion', () => {
  it('keeps the review without asking the agent again', async () => {
    const { retryOnSchema } = await import('../../server/refine/agent-failure.js');
    let calls = 0;
    const answer = { specHash: 'h', docPatch: [{ find: 'a', reason: 'r' }, { find: 'b' }], questions: [] };
    const out = await retryOnSchema<Out>(async () => {
      calls++;
      return failed(answer, ['docPatch.1.reason: Required']);
    }, Schema);
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: true, value: { docPatch: [{ find: 'a', reason: 'r' }] } });
  });

  it('asks again when the answer cannot be repaired', async () => {
    const { retryOnSchema } = await import('../../server/refine/agent-failure.js');
    let calls = 0;
    await retryOnSchema<Out>(async () => {
      calls++;
      return failed({ specHash: 'h' }, ['specHash: Required']);
    }, Schema);
    expect(calls).toBe(2);
  });
});
