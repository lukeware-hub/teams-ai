import type { Report } from '../orchestrator/phases/report.js';
import { queryPage, type Page, type PageRequest, type TableSpec } from './paging.js';

type Smoke = NonNullable<Report['service']>['smoke'][number];
type Evidence = Report['evidence'][number];

export const VALIDATION_TABLES = ['smoke', 'evidence'] as const;
export type ValidationTable = (typeof VALIDATION_TABLES)[number];

const SMOKE: TableSpec<Smoke> = {
  sorts: { criterion: (s) => `${s.acId} ${s.service ?? ''}`, test: (s) => s.testId ?? null, result: (s) => s.status },
  text: (s) => [s.acId, s.service ?? '', s.testId ?? ''],
  facet: (s) => s.status,
};

const EVIDENCE: TableSpec<Evidence> = {
  sorts: {
    criterion: (r) => r.criterion,
    tasks: (r) => r.tasks.join(', ') || null,
    tests: (r) => r.tests.join(', ') || null,
    e2e: (r) => r.e2e ?? null,
    result: (r) => r.status,
  },
  text: (r) => [r.criterion, ...r.tasks, ...r.tests],
  facet: (r) => r.status,
};

/** One page of a run's validation table, cut from its report; a run with no report has no rows. */
export function validationPage(report: Report | null, table: ValidationTable, req: PageRequest): Page<Smoke> | Page<Evidence> {
  return table === 'smoke' ? queryPage(report?.service?.smoke ?? [], SMOKE, req) : queryPage(report?.evidence ?? [], EVIDENCE, req);
}

/** The report without its table rows, which the validation tables read one page at a time. */
export function withoutTableRows(report: Report | null): Report | null {
  if (report === null) return null;
  const out: Report = { ...report };
  if (Array.isArray(report.evidence)) out.evidence = [];
  if (report.service && Array.isArray(report.service.smoke)) out.service = { ...report.service, smoke: [] };
  return out;
}
