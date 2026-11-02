// Reads the files under docs/ of a GitHub tree, so the live check never writes to the documentation store.

/** The owner and name of a GitHub remote, such as https://github.com/owner/name.git. */
export function repoPath(remote) {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (match === null) throw new Error(`not a GitHub remote: ${remote}`);
  return match[1];
}

/** The paths under docs/ of a recursive GitHub tree; a truncated tree is refused, because it hides files. */
export function docsPaths(tree) {
  if (tree.truncated) throw new Error('the GitHub tree is truncated; the allowlist cannot see every file');
  return tree.tree.filter((entry) => entry.type === 'blob' && entry.path.startsWith('docs/')).map((entry) => entry.path);
}
