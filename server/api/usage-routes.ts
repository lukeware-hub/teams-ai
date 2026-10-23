import type { ClaudeUsage } from '../usage/claude-usage.js';
import type { Route } from './server.js';

export interface UsageDeps {
  claude: () => Promise<ClaudeUsage>;
}

export function usageRoutes(deps: UsageDeps): Route[] {
  return [{ method: 'GET', path: '/api/usage/claude', handler: async ({ json }) => json(200, await deps.claude()) }];
}
