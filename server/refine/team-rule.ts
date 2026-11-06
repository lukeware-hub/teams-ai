import { AsyncLocalStorage } from 'node:async_hooks';
import { isApproval, type PatchRow } from './state.js';
import { additiveOnly } from './scope-guard.js';

/**
 * Whether a pending suggestion is accepted without the owner. The team alone, on a follow-on request, takes an addition to any
 * document and a rewording that changes no scope, so it repairs contradictions, wording and stack gaps by itself. A change of
 * scope (adding or cutting functionality) and an adjustment's approval always wait for the owner.
 */
export function autoAcceptable(p: Pick<PatchRow, 'find' | 'replace'> & { scopeChange?: boolean }, teamAlone: boolean): boolean {
  if (!teamAlone) return true;
  return !isApproval(p) && (additiveOnly(p.find, p.replace) || p.scopeChange === false);
}

const teamScope = new AsyncLocalStorage<boolean>();

/** Runs `run` as the team alone when `teamAlone`: every suggestion accepted inside it, by any step, follows autoAcceptable. */
export const asTeamAlone = <T>(teamAlone: boolean, run: () => Promise<T>): Promise<T> => teamScope.run(teamAlone, run);

/** Whether the code running now is the team alone on a follow-on request. */
export const inTeamAlone = (): boolean => teamScope.getStore() === true;
