import type { Exec } from '../exec/command.js';
import type { Spec } from '../contracts/spec.js';

const USER = 'teamsai';
const DB = 'teamsai';
const IMAGE = 'postgres:16';

/**
 * Does this spec's own externalDependencies name a `DATABASE_URL` secret? The one signal already in the
 * contract, rather than guessing from a name or purpose. A spec with no such secret never pays for a
 * container it would not use.
 */
export function needsTestDatabase(spec: Pick<Spec, 'externalDependencies'>): boolean {
  return spec.externalDependencies.some((d) => d.secretNames.includes('DATABASE_URL'));
}

export type TestDatabaseResult = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Runs a disposable PostgreSQL the orchestrator owns end to end (never the agent sandbox, which never gets
 * Docker): detached, named so a crash can find and remove it, `--rm` so a clean exit never leaves it behind,
 * published on `serviceHost` (the same host steps already reach for the deployed service) at a caller-chosen
 * port. Waits for `pg_isready` before returning the connection string; a failure is reported, never thrown,
 * so a run that cannot provision one just runs its integration tasks without DATABASE_URL, as before.
 */
export async function startTestDatabase(
  exec: Exec,
  opts: { containerName: string; serviceHost: string; port: number; readyTimeoutMs?: number; pollMs?: number },
): Promise<TestDatabaseResult> {
  const run = await exec({
    bin: 'docker',
    args: ['run', '-d', '--rm', '--name', opts.containerName, '-p', `${opts.port}:5432`, '-e', `POSTGRES_USER=${USER}`, '-e', `POSTGRES_PASSWORD=${USER}`, '-e', `POSTGRES_DB=${DB}`, IMAGE],
    timeoutMs: 30_000,
  });
  if (run.exitCode !== 0) return { ok: false, reason: `docker run failed: ${run.stderr.trim() || run.stdout.trim()}` };
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 60_000);
  const pollMs = opts.pollMs ?? 1_000;
  for (;;) {
    const ready = await exec({ bin: 'docker', args: ['exec', opts.containerName, 'pg_isready', '-U', USER], timeoutMs: 10_000 });
    if (ready.exitCode === 0) return { ok: true, url: `postgres://${USER}:${USER}@${opts.serviceHost}:${opts.port}/${DB}` };
    if (Date.now() >= deadline) return { ok: false, reason: `postgres did not become ready within ${opts.readyTimeoutMs ?? 60_000}ms: ${ready.stderr.trim() || ready.stdout.trim()}` };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Idempotent, never throws: cleanup must never fail a run that is already finishing for some other reason. */
export async function stopTestDatabase(exec: Exec, containerName: string): Promise<void> {
  await exec({ bin: 'docker', args: ['rm', '-f', containerName], timeoutMs: 30_000 }).catch(() => undefined);
}
