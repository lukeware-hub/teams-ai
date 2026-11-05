import { describe, expect, it } from 'vitest';
import { money, ofTotal, percent, shareOf, sumMoney, tokens, unpricedNote } from './format.js';

describe('cost formats', () => {
  it('writes dollars in pt-BR with a no-break space after US$', () => {
    expect(money(39.67)).toBe('US$ 39,67');
    expect(money(1234.5)).toBe('US$ 1.234,50');
  });

  it('writes tokens in the short pt-BR form', () => {
    expect(tokens(5_700_000)).toBe('5,7 mi tokens');
    expect(tokens(1200)).toBe('1,2 mil tokens');
  });

  it('writes shares as whole percents, and a share of an empty whole as zero', () => {
    expect(percent(0.156)).toBe('16%');
    expect(shareOf(3, 0)).toBe(0);
    expect(ofTotal(6.35, 39.67)).toBe('16% do total');
  });

  it('says how many steps have no reported cost, and nothing when every step has one', () => {
    expect(unpricedNote(2)).toBe(' · 2 sem custo informado');
    expect(unpricedNote(0)).toBe('');
  });

  it('adds several money parts field by field', () => {
    expect(sumMoney([
      { costUsd: 1.5, tokens: 10, steps: 2, semCusto: 0 },
      { costUsd: 2.5, tokens: 20, steps: 3, semCusto: 1 },
    ])).toEqual({ costUsd: 4, tokens: 30, steps: 5, semCusto: 1 });
  });
});
