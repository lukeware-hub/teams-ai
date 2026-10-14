import { describe, expect, it } from 'vitest';
import { DATASTORE_CREDENTIALS, datastoreCredentialsOf } from '../../server/deploy/datastore-credentials.js';

describe('datastoreCredentialsOf', () => {
  it('keeps only the datastore passwords among the project secrets', () => {
    expect(datastoreCredentialsOf({ POSTGRES_PASSWORD: 'p', GITHUB_TOKEN: 't', REDIS_PASSWORD: 'r' })).toEqual({ POSTGRES_PASSWORD: 'p', REDIS_PASSWORD: 'r' });
    expect(datastoreCredentialsOf({})).toEqual({});
    expect(datastoreCredentialsOf({ POSTGRES_PASSWORD: 'p', PLATFORM_ADMIN_TOKEN: 'a', GITHUB_TOKEN: 't' }, ['PLATFORM_ADMIN_TOKEN'])).toEqual({ POSTGRES_PASSWORD: 'p', PLATFORM_ADMIN_TOKEN: 'a' });
    expect(DATASTORE_CREDENTIALS).toContain('POSTGRES_PASSWORD');
  });
});
