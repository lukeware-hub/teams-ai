import { buildContextPack, type ContextPackInput } from '../knowledge/context-pack.js';

export const PACK_TOKEN_CAP = 120_000;
const MARGIN_TOKENS = 2_000;

export class PackTooLargeError extends Error {}

/**
 * The docs travel in the droppable `feedback` section, which the pack removes whole when over budget. Raise the budget to
 * what the pack needs, so a large flow.md is never silently left out of derive or review; refuse beyond the cap.
 */
export function fitPackBudget(input: ContextPackInput): ContextPackInput {
  const needed = buildContextPack({ ...input, budgetTokens: Number.MAX_SAFE_INTEGER }).tokens + MARGIN_TOKENS;
  if (needed > PACK_TOKEN_CAP) {
    throw new PackTooLargeError(
      `Os documentos são grandes demais para uma avaliação (cerca de ${Math.round(needed / 1000)} mil tokens; o limite é ${PACK_TOKEN_CAP / 1000} mil). Reduza ou divida o conteúdo dos documentos.`,
    );
  }
  return { ...input, budgetTokens: Math.max(input.budgetTokens, needed) };
}
