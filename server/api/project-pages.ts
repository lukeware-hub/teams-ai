import type { TableSpec } from './paging.js';

/** The run fields the project page lists; a server run row carries them. */
export interface PageRun {
  runId: string;
  specId: string;
  kind: string;
  n: number;
  status: string;
  at: string | null;
  tokens: number;
  cost: number;
}

/** The spec fields the project page lists; a server spec row carries them. */
export interface PageSpec {
  specId: string;
  status: string;
  activeRunId: string | null;
}

/** A spec as the project hub lists it: the status its chip shows and the run its actions open. */
export interface SpecPageRow extends PageSpec {
  shownStatus: string;
  lastRunId: string;
}

export const RUN_TABLE: TableSpec<PageRun> = {
  sorts: { run: (r) => r.n, spec: (r) => r.specId, at: (r) => (r.at ? Date.parse(r.at) : null), status: (r) => r.status, tokens: (r) => r.tokens, cost: (r) => r.cost },
  text: (r) => [r.runId, r.specId],
  facet: (r) => r.status,
};

export function specPageRow(spec: PageSpec, runs: readonly PageRun[]): SpecPageRow {
  const active = spec.activeRunId ? runs.find((r) => r.runId === spec.activeRunId) : undefined;
  const shownStatus = spec.activeRunId ? (active?.status ?? 'running') : spec.status === 'running' ? 'idle' : spec.status;
  const lastRunId = runs.find((r) => r.specId === spec.specId && r.kind === 'run')?.runId ?? runs.find((r) => r.specId === spec.specId && r.kind === 'deploy')?.runId ?? '';
  return { ...spec, shownStatus, lastRunId };
}

export const SPEC_TABLE: TableSpec<SpecPageRow> = {
  text: (s) => [s.specId],
  facet: (s) => s.shownStatus,
};
