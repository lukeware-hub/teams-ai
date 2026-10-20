/** The file in node_modules that records the commit its dependencies were installed for. */
export const INSTALLED_AT = '.teams-ai-installed-at';

/** Dependencies install again when none are present or they were installed for another commit, as after a rebase onto a main that changed the lock file. */
export function needsInstall(present: boolean, installedAt: string | null, head: string): boolean {
  return !present || installedAt !== head;
}
