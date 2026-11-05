import { AsyncLocalStorage } from 'node:async_hooks';
import { isApproval, type PatchRow } from './state.js';
import { additiveOnly } from './scope-guard.js';

/** The documents a request may change without the owner, and only by adding to them: stack and design stay with the owner. */
const REQUEST_FILES: readonly string[] = ['project.md', 'flow.md', 'briefing.md'];

/**
 * Whether a pending suggestion is accepted without the owner. The team alone, on a follow-on request, takes only additions to its
 * project's own documents, so a removal, a rewording, an adjustment's approval or a stack or design change waits for the owner.
 */
export function autoAcceptable(p: Pick<PatchRow, 'file' | 'find' | 'replace'>, teamAlone: boolean): boolean {
  if (!teamAlone) return true;
  return REQUEST_FILES.includes(p.file) && additiveOnly(p.find, p.replace) && !isApproval(p);
}

const teamScope = new AsyncLocalStorage<boolean>();

/** Runs `run` as the team alone when `teamAlone`: every suggestion accepted inside it, by any step, follows autoAcceptable. */
export const asTeamAlone = <T>(teamAlone: boolean, run: () => Promise<T>): Promise<T> => teamScope.run(teamAlone, run);

/** Whether the code running now is the team alone on a follow-on request. */
export const inTeamAlone = (): boolean => teamScope.getStore() === true;
