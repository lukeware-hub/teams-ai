import { describe, expect, it } from 'vitest';
import { repairedDatabaseUrl, sharedDatabase } from '../../server/orchestrator/shared-database.js';
import { makeProject } from '../fixtures/contracts.js';

const system = makeProject({ services: ['policy-registry-api', 'audit-api'] });

describe('sharedDatabase', () => {
  it('adds one PostgreSQL container to the platform and builds the URL every service reads', () => {
    const r = sharedDatabase(system, true, 'pw1')!;
    expect(r.url).toBe('postgres://app:pw1@platform-postgres:5432/app');
    expect(r.project.platform).toEqual([expect.objectContaining({ name: 'platform-postgres', image: 'postgres:17-bookworm', environment: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw1', POSTGRES_DB: 'app' } })]);
  });

  it('keeps the other platform containers', () => {
    const broker = { name: 'nats', image: 'nats:2.10' };
    const r = sharedDatabase({ ...system, platform: [broker] }, true, 'pw1')!;
    expect(r.project.platform?.map((p) => p.name)).toEqual(['nats', 'platform-postgres']);
  });

  it('leaves a project that declares its own postgres alone, since its credentials are not known', () => {
    expect(sharedDatabase({ ...system, platform: [{ name: 'postgres', image: 'postgres:16-bookworm' }] }, true, 'pw1')).toBeNull();
  });

  it('leaves a project alone whatever name its own postgres has', () => {
    expect(sharedDatabase({ ...system, platform: [{ name: 'db', image: 'postgres:16-bookworm' }] }, true, 'pw1')).toBeNull();
  });

  it('never takes the bare name postgres, which a service compose file may also give its own database on the shared network', () => {
    expect(sharedDatabase(system, true, 'pw1')!.project.platform?.some((p) => p.name === 'postgres')).toBe(false);
  });

  it('does nothing when nothing needs a DATABASE_URL', () => {
    expect(sharedDatabase(system, false, 'pw1')).toBeNull();
  });

  it('does nothing for a single application, which keeps its database in its own compose file', () => {
    expect(sharedDatabase(makeProject({ services: undefined }), true, 'pw1')).toBeNull();
  });

  it('does nothing without a generated password', () => {
    expect(sharedDatabase(system, true, undefined)).toBeNull();
  });
});

describe('repairedDatabaseUrl', () => {
  const platform = [{ name: 'postgres', image: 'postgres:17-bookworm' }];

  it('points a host nobody starts at the project postgres and keeps the credentials', () => {
    expect(repairedDatabaseUrl('postgres://app:pw@db:5432/app', platform)).toBe('postgres://app:pw@postgres:5432/app');
  });

  it('leaves a URL whose host is already a platform container', () => {
    expect(repairedDatabaseUrl('postgres://app:pw@postgres:5432/app', platform)).toBeNull();
  });

  it('leaves dotted, local and missing addresses alone', () => {
    expect(repairedDatabaseUrl('postgres://app:pw@db.example.com:5432/app', platform)).toBeNull();
    expect(repairedDatabaseUrl('postgres://app:pw@localhost:5432/app', platform)).toBeNull();
    expect(repairedDatabaseUrl(undefined, platform)).toBeNull();
  });

  it('does nothing when the platform has no single postgres to point at', () => {
    expect(repairedDatabaseUrl('postgres://app:pw@db:5432/app', [])).toBeNull();
    expect(repairedDatabaseUrl('postgres://app:pw@db:5432/app', [{ name: 'a', image: 'postgres:16' }, { name: 'b', image: 'postgres:17' }])).toBeNull();
  });
});
