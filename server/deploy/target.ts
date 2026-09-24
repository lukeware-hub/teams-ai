export interface DeploymentIntent {
  projectId: string;
  image: string;
  tag: string;
  port: number;
  healthcheckPath: string;
  manifests: string[];
  secretNames: string[];
  /** Directory with the Dockerfile and manifests (the merged main checkout). */
  contextDir: string;
}

export interface DeployTarget {
  readonly name: 'docker-local' | 'kind';
  validate(intent: DeploymentIntent): Promise<string[]>;
  build(intent: DeploymentIntent): Promise<void>;
  apply(intent: DeploymentIntent): Promise<{ previous: string | null }>;
  verify(intent: DeploymentIntent): Promise<{ healthy: boolean; detail: string }>;
  rollback(intent: DeploymentIntent, previous: string): Promise<void>;
  destroy(intent: DeploymentIntent): Promise<void>;
}

export type DeployStage = 'validate' | 'build' | 'apply' | 'verify' | 'smoke';

export type DeployResult =
  | { ok: true; previous: string | null }
  | { ok: false; stage: DeployStage; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null };

export type HttpGet = (url: string, timeoutMs: number) => Promise<{ status: number } | null>;

export const httpGet: HttpGet = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { status: res.status };
  } catch {
    return null;
  }
};

export async function waitHealthy(
  url: string,
  get: HttpGet,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<{ healthy: boolean; detail: string }> {
  const deadline = Date.now() + opts.timeoutMs;
  let attempts = 0;
  let last: string = 'no response';
  do {
    attempts += 1;
    const r = await get(url, Math.min(opts.intervalMs * 5, 5_000));
    if (r && r.status >= 200 && r.status < 300) return { healthy: true, detail: `HTTP ${r.status} after ${attempts} attempts` };
    last = r ? `HTTP ${r.status}` : 'no response';
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  } while (Date.now() < deadline);
  return { healthy: false, detail: `${last} after ${attempts} attempts (${opts.timeoutMs} ms)` };
}

export const imageRef = (intent: DeploymentIntent) => `${intent.image}:${intent.tag}`;

/**
 * Spec Phase 5: validate → build → apply → verify → smoke. Any failure after apply rolls back to the
 * previous version (when one exists) and re-verifies, so the environment is healthy before the
 * failure is reported and the fix goes through a PR.
 */
export async function runDeployment(
  target: DeployTarget,
  intent: DeploymentIntent,
  deps: { smoke: (baseUrl: string) => Promise<{ ok: boolean; detail: string }>; baseUrl: string },
): Promise<DeployResult> {
  const errors = await target.validate(intent);
  if (errors.length > 0) return { ok: false, stage: 'validate', detail: errors.join('; '), rolledBack: false, rollbackHealthy: null };
  try {
    await target.build(intent);
  } catch (err) {
    return { ok: false, stage: 'build', detail: (err as Error).message, rolledBack: false, rollbackHealthy: null };
  }
  let previous: string | null = null;
  try {
    previous = (await target.apply(intent)).previous;
  } catch (err) {
    return { ok: false, stage: 'apply', detail: (err as Error).message, rolledBack: false, rollbackHealthy: null };
  }
  const fail = async (stage: DeployStage, detail: string): Promise<DeployResult> => {
    if (!previous) return { ok: false, stage, detail, rolledBack: false, rollbackHealthy: null };
    await target.rollback(intent, previous);
    const back = await target.verify(intent);
    return { ok: false, stage, detail, rolledBack: true, rollbackHealthy: back.healthy };
  };
  const health = await target.verify(intent);
  if (!health.healthy) return fail('verify', health.detail);
  const smoke = await deps.smoke(deps.baseUrl);
  if (!smoke.ok) return fail('smoke', smoke.detail);
  return { ok: true, previous };
}
