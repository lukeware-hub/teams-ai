import type { RefineLimits } from './state.js';

export const MAX_ROUNDS_ENV = 'TEAMS_AI_REFINE_MAX_ROUNDS';

const DEFAULT_MAX = 50;

/** A positive whole number from the environment, or the default when it is unset or not one. */
const count = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function refineLimits(env: Record<string, string | undefined> = process.env): RefineLimits {
  return { max: count(env[MAX_ROUNDS_ENV], DEFAULT_MAX) };
}
