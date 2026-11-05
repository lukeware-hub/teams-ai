/** One item of an outline, as the diff reads it. */
export interface OutlineRow {
  key: string;
  rank: number;
  dependsOn: readonly string[];
}

/** What a new outline changes against the one it replaces: items added, moved to another rank, re-wired, and the started items it keeps. */
export interface OutlineDiff {
  added: string[];
  moved: Array<{ key: string; from: number; to: number }>;
  dependencies: Array<{ key: string; from: string[]; to: string[] }>;
  locked: string[];
}

/** Browser-safe: the replan view of a follow-on request compares two outlines with this, and the server reads the same result. */
export function outlineDiff(before: readonly OutlineRow[], after: readonly OutlineRow[], started: ReadonlySet<string>): OutlineDiff {
  const was = new Map(before.map((r) => [r.key, r]));
  const now = new Map(after.map((r) => [r.key, r]));
  const sorted = (keys: readonly string[]): string[] => [...keys].sort();
  return {
    added: after.filter((r) => !was.has(r.key)).map((r) => r.key),
    moved: after.flatMap((r) => {
      const old = was.get(r.key);
      return old && old.rank !== r.rank ? [{ key: r.key, from: old.rank, to: r.rank }] : [];
    }),
    dependencies: after.flatMap((r) => {
      const old = was.get(r.key);
      return old && JSON.stringify(sorted(old.dependsOn)) !== JSON.stringify(sorted(r.dependsOn)) ? [{ key: r.key, from: sorted(old.dependsOn), to: sorted(r.dependsOn) }] : [];
    }),
    locked: [...started].filter((key) => was.has(key) || now.has(key)).sort(),
  };
}
