/** The `owner/name` of a GitHub address (https or ssh, with or without `.git`), lower-cased; undefined for an address that is not GitHub's. */
export function githubSlugOf(origin: string): string | undefined {
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin.trim())?.[1]?.toLowerCase();
}

/** Whether an address belongs to the owner: an address that is not GitHub's, or an owner that is not given, is not held against it. */
export function belongsTo(origin: string, owner: string | undefined): boolean {
  const slug = githubSlugOf(origin);
  return owner === undefined || slug === undefined || slug.split('/')[0] === owner.toLowerCase();
}
