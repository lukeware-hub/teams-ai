import { describe, expect, it } from 'vitest';
import { siblingRepoUrl } from '../../server/api/run-routes.js';

describe('siblingRepoUrl', () => {
  it('points a sibling repository at the same owner and host', () => {
    expect(siblingRepoUrl('https://github.com/lukeware-kayron-hub/kayron-hub.git', 'kayron-hub-audit-service')).toBe('https://github.com/lukeware-kayron-hub/kayron-hub-audit-service.git');
    expect(siblingRepoUrl('https://git.example.com/acme/demo', 'demo-api')).toBe('https://git.example.com/acme/demo-api.git');
  });
});
