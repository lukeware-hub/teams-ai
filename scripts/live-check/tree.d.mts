/** The owner and name of a GitHub remote, such as owner/name. */
export function repoPath(remote: string): string;

/** The paths under docs/ of a recursive GitHub tree. */
export function docsPaths(tree: { truncated: boolean; tree: { path: string; type: string }[] }): string[];
