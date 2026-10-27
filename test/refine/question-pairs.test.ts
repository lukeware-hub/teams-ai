import { describe, expect, it } from 'vitest';
import { MAX_DEDUP_PAIRS, questionPairs } from '../../server/refine/question-pairs.js';

/** A made-up word of letters only, different for each number, so filler questions share no words. */
const word = (n: number): string => [...String(n).padStart(4, '0')].map((d) => 'bcdfghjklm'[Number(d)]).join('');
/** Questions on one criterion that share no words with each other or with the repeat. */
const unrelated = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ text: `${word(from + i)}?`, relatedAcIds: ['AC-001'] }));

describe('questionPairs', () => {
  it('finds the near-duplicate of an old question among 300 unrelated ones, and never returns more pairs than the cap', () => {
    const original = { text: 'Quem aprova as alterações da constituição do projeto?', relatedAcIds: [] };
    const repeat = { text: 'Confirme quem aprova as alterações desta constituição.', relatedAcIds: [] };
    const earlier = [original, ...unrelated(0, 300)];
    // The new questions on the shared criterion bring far more candidates than the cap.
    const fresh = [...unrelated(1000, 40), repeat];
    const pairs = questionPairs(fresh, (_, i) => [...earlier, ...fresh.slice(0, i)]);
    expect(pairs).toContainEqual(expect.objectContaining({ a: original.text, b: repeat.text }));
    expect(pairs).toHaveLength(MAX_DEDUP_PAIRS);
  });
});
