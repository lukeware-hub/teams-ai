import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startApi } from '../../server/api/server.js';
import { usageRoutes } from '../../server/api/usage-routes.js';
import type { ClaudeUsage } from '../../server/usage/claude-usage.js';

const view: ClaudeUsage = { available: false, reason: 'not-logged-in' };
let api: { port: number; close(): Promise<void> };

beforeEach(async () => {
  api = await startApi({ routes: usageRoutes({ claude: async () => view }) }, 0);
});
afterEach(async () => {
  await api.close();
});

describe('usage routes', () => {
  it('answers the Claude usage view as json', async () => {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/usage/claude`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
  });
});
