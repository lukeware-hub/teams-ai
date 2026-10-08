import { describe, expect, it } from 'vitest';
import { needsTestDatabase, startTestDatabase, stopTestDatabase } from '../../server/orchestrator/test-database.js';
import { makeSpec } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';

describe('needsTestDatabase', () => {
  it('is true only when a spec declares the DATABASE_URL secret', () => {
    const withDb = makeSpec({ externalDependencies: [{ name: 'postgres', purpose: 'store books', secretNames: ['DATABASE_URL'] }] });
    const withoutDb = makeSpec({ externalDependencies: [{ name: 'smtp', purpose: 'email', secretNames: ['SMTP_HOST'] }] });
    const none = makeSpec({ externalDependencies: [] });
    expect(needsTestDatabase(withDb)).toBe(true);
    expect(needsTestDatabase(withoutDb)).toBe(false);
    expect(needsTestDatabase(none)).toBe(false);
  });
});

describe('startTestDatabase', () => {
  it('runs a detached, named postgres container, waits for it to accept connections, and returns its connection string', async () => {
    const exec = new FakeExec();
    exec.onArgs('docker', ['exec'], () => ({ exitCode: 0, stdout: 'accepting connections' }));
    const result = await startTestDatabase(exec.exec, { containerName: 'teams-ai-r1-testdb', serviceHost: 'dind', port: 55432 });
    expect(result).toEqual({ ok: true, url: 'postgres://teamsai:teamsai@dind:55432/teamsai' });
    const run = exec.calls.find((c) => c.bin === 'docker' && c.args[0] === 'run');
    expect(run?.args).toEqual(
      expect.arrayContaining(['run', '-d', '--rm', '--name', 'teams-ai-r1-testdb', '-p', '55432:5432', '-e', 'POSTGRES_USER=teamsai', '-e', 'POSTGRES_PASSWORD=teamsai', '-e', 'POSTGRES_DB=teamsai', 'postgres:16']),
    );
    const check = exec.calls.find((c) => c.bin === 'docker' && c.args[0] === 'exec');
    expect(check?.args).toEqual(expect.arrayContaining(['exec', 'teams-ai-r1-testdb', 'pg_isready', '-U', 'teamsai']));
  });

  it('gives up and reports the reason when the container never becomes ready, without throwing', async () => {
    const exec = new FakeExec();
    exec.onArgs('docker', ['exec'], () => ({ exitCode: 1, stderr: 'no response' }));
    const result = await startTestDatabase(exec.exec, { containerName: 'teams-ai-r2-testdb', serviceHost: 'dind', port: 55433, readyTimeoutMs: 50, pollMs: 10 });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('did not become ready') });
  });

  it('reports the reason when the container fails to start at all', async () => {
    const exec = new FakeExec();
    exec.onArgs('docker', ['run'], () => ({ exitCode: 1, stderr: 'port is already allocated' }));
    const result = await startTestDatabase(exec.exec, { containerName: 'teams-ai-r3-testdb', serviceHost: 'dind', port: 55434 });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('port is already allocated') });
  });
});

describe('stopTestDatabase', () => {
  it('removes the container and never throws even when it is already gone', async () => {
    const exec = new FakeExec();
    exec.onArgs('docker', ['rm'], () => ({ exitCode: 1, stderr: 'No such container' }));
    await expect(stopTestDatabase(exec.exec, 'teams-ai-r1-testdb')).resolves.toBeUndefined();
    expect(exec.lines('docker')).toContain('rm -f teams-ai-r1-testdb');
  });
});
