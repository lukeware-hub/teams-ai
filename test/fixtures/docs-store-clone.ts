import type { Style } from '../../server/docs/layout.js';
import { commitProjection, openStore, pushWithRecovery, type Projection, type Store } from '../../server/docs/store.js';
import { docsStoreDir } from '../../server/docs/project-state.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import type { Remote } from './git-remote.js';

/** The documentation store of a project, cloned from the remote's bare origin. */
export async function cloneStore(ws: { root: string }, remote: Remote, style: Style = 'monolith'): Promise<Store> {
  await git(ws.root, ['clone', '-q', remote.origin, docsStoreDir(ws)]);
  return openStore(ws, style, execCommand);
}

/** Commits a projection to the store and publishes it, as a draft's boundary does; a refusal fails the test. */
export async function publish(store: Store, projection: Projection): Promise<void> {
  const flushed = await commitProjection(store, projection);
  const refused = [...flushed.diverged, ...flushed.aliasTaken];
  if (refused.length > 0) throw new Error(`refused: ${refused.join(', ')}`);
  const pushed = await pushWithRecovery(store);
  if (!pushed.ok) throw new Error(pushed.message);
}
