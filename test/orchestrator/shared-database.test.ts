import { describe, expect, it } from 'vitest';
import { sharedDatabase } from '../../server/orchestrator/shared-database.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

const withDb = makeSpec({ externalDependencies: [{ name: 'postgres', purpose: 'store policies', secretNames: ['DATABASE_URL'] }] });
const withoutDb = makeSpec({ externalDependencies: [] });
const system = makeProject({ services: ['policy-registry-api', 'audit-api'] });

describe('sharedDatabase', () => {
  it('adds one PostgreSQL container to the platform and builds the URL every service reads', () => {
    const r = sharedDatabase(system, [withoutDb, withDb], 'pw1')!;
    expect(r.url).toBe('postgres://app:pw1@postgres:5432/app');
    expect(r.project.platform).toEqual([expect.objectContaining({ name: 'postgres', image: 'postgres:17-bookworm', environment: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw1', POSTGRES_DB: 'app' } })]);
  });

  it('keeps the other platform containers', () => {
    const broker = { name: 'nats', image: 'nats:2.10' };
    const r = sharedDatabase({ ...system, platform: [broker] }, [withDb], 'pw1')!;
    expect(r.project.platform?.map((p) => p.name)).toEqual(['nats', 'postgres']);
  });

  it('leaves a project that declares its own postgres alone, since its credentials are not known', () => {
    expect(sharedDatabase({ ...system, platform: [{ name: 'postgres', image: 'postgres:16-bookworm' }] }, [withDb], 'pw1')).toBeNull();
  });

  it('does nothing when no spec of the project names a DATABASE_URL', () => {
    expect(sharedDatabase(system, [withoutDb], 'pw1')).toBeNull();
  });

  it('does nothing for a single application, which keeps its database in its own compose file', () => {
    expect(sharedDatabase(makeProject({ services: undefined }), [withDb], 'pw1')).toBeNull();
  });

  it('does nothing without a generated password', () => {
    expect(sharedDatabase(system, [withDb], undefined)).toBeNull();
  });
});
