/** Name of the coverage gate (roadmap R10.2). Stack-agnostic: the agent picks whatever coverage tool its
 * stack has; the gate only has to leave this one normalized signal behind. */
export const COVERAGE_GATE = 'coverage';

/** Floor every plan's coverage gate must clear when coverage is required (roadmap R10.2, human decision 2026-10-06). */
export const MIN_LINE_COVERAGE_PCT = 80;

export interface CoverageSummary {
  linesPct: number;
}

/**
 * Parses the one-line JSON file the coverage gate's command must write, e.g. `{"linesPct": 83.4}`. Null on
 * anything malformed or missing the field - the caller fails closed rather than trusting an unreadable claim.
 */
export function parseCoverageSummary(raw: string): CoverageSummary | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const pct = (data as Record<string, unknown>).linesPct;
  return typeof pct === 'number' && Number.isFinite(pct) ? { linesPct: pct } : null;
}

export function coveragePasses(summary: CoverageSummary | null, minPct: number = MIN_LINE_COVERAGE_PCT): boolean {
  return summary !== null && summary.linesPct >= minPct;
}
