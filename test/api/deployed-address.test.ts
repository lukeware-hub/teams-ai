import { describe, expect, it } from 'vitest';
import { withDeployedAddress } from '../../server/api/run-routes.js';

describe('withDeployedAddress', () => {
  it('replaces the address of a single service report with the one this run deployed', () => {
    const report = { specId: 's', service: { url: 'http://dind:20052', port: 20052, healthcheck: 'ok' } };
    expect(withDeployedAddress(report, { url: 'http://dind:20069', port: 20069 })).toEqual({ specId: 's', service: { url: 'http://dind:20069', port: 20069, healthcheck: 'ok' } });
  });
  it('replaces each service of a services report by name and keeps the others', () => {
    const report = { services: [{ service: 'api', url: 'http://dind:20001', port: 20001 }, { service: 'web', url: 'http://dind:20002', port: 20002 }] };
    const out = withDeployedAddress(report, { url: 'x', services: [{ service: 'api', url: 'http://dind:20011', port: 20011 }] }) as typeof report;
    expect(out.services).toEqual([{ service: 'api', url: 'http://dind:20011', port: 20011 }, { service: 'web', url: 'http://dind:20002', port: 20002 }]);
  });
  it('leaves a missing report as it is', () => {
    expect(withDeployedAddress(null, { url: 'x', port: 1 })).toBeNull();
  });
});
