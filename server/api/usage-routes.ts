import type { ClaudeUsage } from '../usage/claude-usage.js';
import type { Route } from './server.js';

export interface UsageDeps {
  claude: () => Promise<ClaudeUsage>;
  jev: () => Promise<number>;
}

export function usageRoutes(deps: UsageDeps): Route[] {
  return [
    { method: 'GET', path: '/api/usage/claude', handler: async ({ json }) => json(200, await deps.claude()) },
    { method: 'GET', path: '/api/usage/jev', handler: async ({ json }) => json(200, { costUsd: await deps.jev() }) },
  ];
}
