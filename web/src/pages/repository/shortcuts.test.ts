import { describe, expect, it } from 'vitest';
import type { LastDeploy, ServiceStatus } from '../../api.js';
import { isOffline, shortcutsOf } from './shortcuts.js';

const deploy = (over: Partial<LastDeploy> = {}): LastDeploy => ({ runId: 'r1', specId: 'cart', url: 'http://localhost:3001', docsPath: '/docs', services: null, ...over });
const probe = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({ online: true, status: 200, ui: true, docs: true, checkedAt: '2026-11-01T10:00:00.000Z', ...over });

describe('shortcuts of a repository', () => {
  it('gives the Swagger of an API only while the probe answers for its documentation', () => {
    expect(shortcutsOf('api', 'shop-api', deploy(), probe())).toEqual([{ kind: 'swagger', href: 'http://localhost:3001/docs' }]);
    expect(shortcutsOf('api', 'shop-api', deploy(), probe({ docs: false }))).toEqual([]);
  });

  it('gives the running application of a web repository while the probe sees its page', () => {
    expect(shortcutsOf('web', 'shop-web', deploy(), probe())).toEqual([{ kind: 'app', href: 'http://localhost:3001' }]);
    expect(shortcutsOf('web', 'shop-web', deploy(), probe({ ui: false }))).toEqual([]);
  });

  it('gives both links for a monolith and only the Swagger for workers', () => {
    expect(shortcutsOf('monolith', 'live-skill', deploy(), probe())).toHaveLength(2);
    expect(shortcutsOf('jobs', 'worker', deploy(), probe())).toEqual([{ kind: 'swagger', href: 'http://localhost:3001/docs' }]);
  });

  it('gives nothing for a mobile or workflow repository, or while the system is down', () => {
    expect(shortcutsOf('mobile', 'app', deploy(), probe())).toEqual([]);
    expect(shortcutsOf('api', 'shop-api', deploy(), probe({ online: false }))).toEqual([]);
    expect(shortcutsOf('api', 'shop-api', null, probe())).toEqual([]);
  });

  it('takes the address of the repository\'s own service when the deploy has several', () => {
    const multi = deploy({ url: null, docsPath: null, services: [{ service: 'shop-api', url: 'http://localhost:3002', docsPath: '/swagger' }] });
    const answers = probe({ services: [{ service: 'shop-api', online: true, status: 200, ui: false, docs: true }] });
    expect(shortcutsOf('api', 'shop-api', multi, answers)).toEqual([{ kind: 'swagger', href: 'http://localhost:3002/swagger' }]);
  });
});

describe('a system that is down', () => {
  it('reads as offline only when there is a deploy and the probe says it does not answer', () => {
    expect(isOffline(deploy(), probe({ online: false }))).toBe(true);
    expect(isOffline(deploy(), probe())).toBe(false);
    expect(isOffline(deploy(), null)).toBe(false);
    expect(isOffline(null, probe({ online: false }))).toBe(false);
  });
});
