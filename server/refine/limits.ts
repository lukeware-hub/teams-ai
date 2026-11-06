import type { RefineLimits } from './state.js';

export const MAX_ROUNDS_ENV = 'TEAMS_AI_REFINE_MAX_ROUNDS';

const DEFAULT_MAX = 50;

/** A positive whole number from the environment, or the default when it is unset or not one. */
const count = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const LEAN_ENV = 'TEAMS_AI_REFINE_LEAN';

/** The lean refinement: the team evaluates once and settles what the reviewers found, instead of evaluating again after each fix. On unless the environment says 0. */
export const leanRefine = (env: Record<string, string | undefined> = process.env): boolean => env[LEAN_ENV] !== '0';

export function refineLimits(env: Record<string, string | undefined> = process.env): RefineLimits {
  return { max: count(env[MAX_ROUNDS_ENV], DEFAULT_MAX) };
}
