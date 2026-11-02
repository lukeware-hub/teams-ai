import { FIVE_DOC_PATHS } from '../docs/layout.js';
import { listState, readStateText } from '../docs/project-state.js';
import { readStoreText, type Store } from '../docs/store.js';
import { fetch as gitFetch } from '../git/git.js';
import type { Workspace } from '../orchestrator/workspace.js';
import type { MainCopy } from './draft.js';

/** The JSON files of the mirror, as repository paths under docs/: the project's, then each spec's. */
async function mirrorJson(ws: Pick<Workspace, 'root'>): Promise<string[]> {
  const root = (await listState(ws, '')).filter((f) => f.endsWith('.json'));
  const specs = await listState(ws, 'specs');
  const nested = await Promise.all(specs.map(async (alias) => (await listState(ws, `specs/${alias}`)).filter((f) => f.endsWith('.json')).map((f) => `specs/${alias}/${f}`)));
  return [...root, ...nested.flat()].map((rel) => `docs/${rel}`);
}

/** Main of a documentation repository: the five documents from the store's HEAD, the JSON from the mirror. */
export function docsRepoMain(ws: Pick<Workspace, 'root'>, store: Store): MainCopy {
  const text = (rel: string): Promise<string | null> =>
    rel.endsWith('.json') ? readStateText(ws, rel.slice('docs/'.length)).then((t) => t ?? null) : readStoreText(store, rel);
  return {
    strict: true,
    refresh: () => gitFetch(store.dir, store.exec),
    files: async () => {
      const docs = await Promise.all(FIVE_DOC_PATHS.map(async (rel) => ((await readStoreText(store, rel)) === null ? [] : [rel])));
      return [...docs.flat(), ...(await mirrorJson(ws))];
    },
    text,
  };
}
