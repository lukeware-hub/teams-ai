import type { GraphViewNode } from './repository-graph.js';

export interface GraphLinkDeps {
  /** A permalink to one line of a file at a commit, or null when a part does not look right. */
  blobUrl: (repoUrl: string, commit: string, file: string, line: number) => string | null;
  /** The GitHub page of the clone, or null when it has no GitHub origin. */
  repoUrlOf: (dir: string) => Promise<string | null>;
  /** The trimmed output of a git command in the clone, or null when the command fails. */
  git: (dir: string, args: string[]) => Promise<string | null>;
}

const safePath = (file: string): boolean => file !== '' && !file.startsWith('/') && !file.split('/').includes('..');

/**
 * Resolves each node to the GitHub page of its file at the clone's current commit. `clones` maps the repository tag of a
 * node to its clone; a node of any other tag has no link. A commit GitHub does not have, or a file the commit does not hold, gives no link rather than a 404.
 */
export function graphLinkResolver(deps: GraphLinkDeps, clones: Readonly<Record<string, string>>): (node: GraphViewNode) => Promise<string | null> {
  // One lookup of the GitHub page and the commit per clone for the whole request.
  const infos = new Map<string, Promise<{ url: string; commit: string } | null>>();
  const infoOf = (dir: string) => {
    let info = infos.get(dir);
    if (!info) {
      info = (async () => {
        const [url, commit] = await Promise.all([deps.repoUrlOf(dir).catch(() => null), deps.git(dir, ['rev-parse', 'HEAD']).catch(() => null)]);
        if (!url || !commit) return null;
        // A commit no remote branch holds is not on GitHub yet, so a link to it would be a 404.
        const pushed = await deps.git(dir, ['branch', '-r', '--contains', commit]).catch(() => null);
        return pushed ? { url, commit } : null;
      })();
      infos.set(dir, info);
    }
    return info;
  };
  return async (node) => {
    const dir = Object.hasOwn(clones, node.repo) ? clones[node.repo] : undefined;
    if (!dir) return null;
    const info = await infoOf(dir);
    if (!info) return null;
    // Some graphs put the folder name in front of the path, so the path is tried again without its first segment.
    const rest = node.file.split('/').slice(1).join('/');
    for (const file of [node.file, rest]) {
      if (!safePath(file)) continue;
      if ((await deps.git(dir, ['cat-file', '-e', `${info.commit}:${file}`]).catch(() => null)) === null) continue;
      return deps.blobUrl(info.url, info.commit, file, node.line ?? 1);
    }
    return null;
  };
}
