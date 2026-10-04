import { listProjects, listRuns, type IndexDeps } from './run-index.js';
import type { Route } from './server.js';

export interface OpsRoutesDeps {
  index: () => Promise<IndexDeps>;
}

const escapeLabel = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Liveness/readiness (`/healthz`) and Prometheus text metrics (`/metrics`); read-only, no auth involvement. */
export function opsRoutes(deps: OpsRoutesDeps): Route[] {
  return [
    {
      method: 'GET',
      path: '/healthz',
      handler: async ({ json }) => json(200, { status: 'ok' }),
    },
    {
      method: 'GET',
      path: '/metrics',
      handler: async ({ res }) => {
        const idx = await deps.index();
        const byStatus = new Map<string, number>();
        let tokens = 0;
        let cost = 0;
        for (const p of await listProjects(idx)) {
          for (const r of await listRuns(idx, p.projectId)) {
            byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
            tokens += r.tokens;
            cost += r.cost;
          }
        }
        const lines = [
          '# HELP teams_ai_runs Runs by status.',
          '# TYPE teams_ai_runs gauge',
          ...[...byStatus].sort(([a], [b]) => a.localeCompare(b)).map(([s, n]) => `teams_ai_runs{status="${escapeLabel(s)}"} ${n}`),
          '# HELP teams_ai_tokens_total Input plus output tokens accounted across runs.',
          '# TYPE teams_ai_tokens_total gauge',
          `teams_ai_tokens_total ${tokens}`,
          '# HELP teams_ai_cost_usd_total Cost in USD accounted across runs.',
          '# TYPE teams_ai_cost_usd_total gauge',
          `teams_ai_cost_usd_total ${Math.round(cost * 1e6) / 1e6}`,
          '# HELP teams_ai_quota_paused Runs currently paused by the quota breaker.',
          '# TYPE teams_ai_quota_paused gauge',
          `teams_ai_quota_paused ${byStatus.get('paused:quota') ?? 0}`,
          '',
        ];
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(lines.join('\n'));
      },
    },
  ];
}
