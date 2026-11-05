import { COST_PERIODS, type CostFact, type CostPeriod } from '../usage/cost-types.js';
import { projectCosts, filterFacts, overview } from '../usage/cost-report.js';
import type { CostScanner } from '../usage/cost-scan.js';
import { queryPage, pageRequest, type TableSpec } from './paging.js';
import { SAFE_ID } from './run-index.js';
import { HttpError, type Route } from './server.js';

export interface CostDeps {
  scanner: CostScanner;
  /** The Jev ledger's total over every project and spec. */
  jevLedgerUsd: () => Promise<number>;
  now?: () => Date;
}

const STEP_TABLE: TableSpec<CostFact> = {
  sorts: {
    data: (f) => Date.parse(f.at),
    custo: (f) => f.costUsd,
    tokens: (f) => f.tokens.inputTokens + f.tokens.outputTokens,
  },
  text: (f) => [f.specId ?? '', f.runId ?? '', f.repository ?? '', f.role ?? '', f.model ?? '', f.kind, f.phase],
  facet: (f) => f.stage,
};

function periodOf(query: URLSearchParams): CostPeriod {
  const period = query.get('period') ?? 'tudo';
  if (!(COST_PERIODS as readonly string[]).includes(period)) throw new HttpError(400, `period must be one of ${COST_PERIODS.join(', ')}`);
  return period as CostPeriod;
}

function idOf(value: string): string {
  if (!SAFE_ID.test(value)) throw new HttpError(400, `invalid id ${JSON.stringify(value)}`);
  return value;
}

export function costRoutes(deps: CostDeps): Route[] {
  const now = () => (deps.now ?? (() => new Date()))();
  return [
    {
      method: 'GET',
      path: '/api/costs',
      handler: async ({ query, json }) => {
        const scan = await deps.scanner.scan();
        json(200, overview({ facts: scan.facts, projects: scan.projects, period: periodOf(query), now: now(), unreadJournals: scan.unreadJournals, jevLedgerUsd: await deps.jevLedgerUsd() }));
      },
    },
    {
      method: 'GET',
      path: '/api/costs/projects/:projectId',
      handler: async ({ params, query, json }) => {
        const scan = await deps.scanner.scan();
        const projectId = idOf(params.projectId!);
        const project = scan.projects.find((p) => p.projectId === projectId);
        if (!project) throw new HttpError(404, `unknown project ${projectId}`);
        json(200, projectCosts({ facts: scan.facts, projectId, name: project.name, period: periodOf(query), now: now(), unreadJournals: scan.unreadJournals }));
      },
    },
    {
      method: 'GET',
      path: '/api/costs/projects/:projectId/steps/page',
      handler: async ({ params, query, json }) => {
        const scan = await deps.scanner.scan();
        const projectId = idOf(params.projectId!);
        if (!scan.projects.some((p) => p.projectId === projectId)) throw new HttpError(404, `unknown project ${projectId}`);
        const facts = filterFacts(
          scan.facts.filter((f) => f.projectId === projectId),
          { period: periodOf(query), now: now(), agent: query.get('agente') || undefined, spec: query.get('spec') || undefined },
        );
        json(200, queryPage(facts, STEP_TABLE, pageRequest(query)));
      },
    },
  ];
}
