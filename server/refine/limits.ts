import type { RefineLimits } from './state.js';

export const RELEASE_ROUNDS_ENV = 'TEAMS_AI_REFINE_RELEASE_ROUNDS';
export const MAX_ROUNDS_ENV = 'TEAMS_AI_REFINE_MAX_ROUNDS';

const DEFAULT_RELEASE = 5;
const DEFAULT_MAX = 10;

/** A positive whole number from the environment, or the default when it is unset or not one. */
const count = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** The release round never sits after the lock round. */
export function refineLimits(env: Record<string, string | undefined> = process.env): RefineLimits {
  const max = count(env[MAX_ROUNDS_ENV], DEFAULT_MAX);
  return { release: Math.min(count(env[RELEASE_ROUNDS_ENV], DEFAULT_RELEASE), max), max };
}
