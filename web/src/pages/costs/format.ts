import type { CostMoney } from '@server/usage/cost-types.js';

const usd = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 });
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

export const money = (amount: number): string => usd.format(amount);
/** A token count in the short pt-BR form, such as `5,7 mi`. */
export const tokenCount = (n: number): string => compact.format(n);
export const tokens = (n: number): string => `${tokenCount(n)} tokens`;
/** A share of a whole, as a whole percent. */
export const percent = (share: number): string => `${Math.round(share * 100)}%`;
/** The part of a whole as a fraction; zero while the whole is empty. */
export const shareOf = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);
/** The part's share of the whole; with no spend in the period there is no share to show. */
export const ofTotal = (part: number, whole: number): string => (whole > 0 ? `${percent(shareOf(part, whole))} do total` : 'Sem custo no período');
/** Calls with no reported cost are counted as steps, and the line says so. */
export const unpricedNote = (count: number): string => (count > 0 ? ` · ${count} sem custo informado` : '');

/** The sum of several money parts, field by field. */
export function sumMoney(parts: readonly CostMoney[]): CostMoney {
  const sum = (key: keyof CostMoney) => parts.reduce((total, part) => total + part[key], 0);
  return { costUsd: sum('costUsd'), tokens: sum('tokens'), steps: sum('steps'), semCusto: sum('semCusto') };
}
