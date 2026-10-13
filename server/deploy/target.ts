import type { PlatformService } from '../contracts/project.js';

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
  /** Repository-relative compose file (`plan.delivery.compose`); when set, docker-local deploys with `docker compose`. */
  compose?: string;
  /** A service of a system of services: its own compose project, its main container on the project's network under `alias`. */
  shared?: { composeProject: string; network: string; alias: string };
}

export interface DeployTarget {
  readonly name: 'docker-local';
  validate(intent: DeploymentIntent): Promise<string[]>;
  build(intent: DeploymentIntent): Promise<void>;
  apply(intent: DeploymentIntent): Promise<{ previous: string | null }>;
  verify(intent: DeploymentIntent): Promise<{ healthy: boolean; detail: string }>;
  /** Image reference currently serving the project, or null when nothing runs. */
  currentImage(intent: DeploymentIntent): Promise<string | null>;
  rollback(intent: DeploymentIntent, previous: string): Promise<void>;
  destroy(intent: DeploymentIntent): Promise<void>;
  serviceUrl?(intent: DeploymentIntent): Promise<string> | string;
  /** The service URL as seen from a gate Job pod (in-cluster Service DNS); absent when the orchestrator's URL already works there. */
  gateServiceUrl?(intent: DeploymentIntent): Promise<string> | string;
  /** Docker network a docker-run gate container must join to reach the service by `gateServiceUrl`; absent means the default bridge. */
  gateNetwork?(intent: DeploymentIntent): string | undefined;
  /** Creates the project's shared network and starts the platform containers the docs declare. */
  startPlatform?(projectId: string, platform: readonly PlatformService[]): Promise<{ ok: boolean; detail: string }>;
  /** Starts again what a service deployed by an earlier spec left stopped (a restart of the host or of the docker daemon), and waits until it is healthy. */
  ensureRunning?(projectId: string, service: string): Promise<{ ok: boolean; detail: string }>;
}

export type DeployStage = 'validate' | 'build' | 'apply' | 'verify' | 'smoke' | 'e2e';

export type DeployResult =
  | { ok: true; previous: string | null }
  | { ok: false; stage: DeployStage; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null };

export type HttpGet = (url: string, timeoutMs: number) => Promise<{ status: number; html?: boolean } | null>;

export const httpGet: HttpGet = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { status: res.status, html: (res.headers.get('content-type') ?? '').includes('text/html') };
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
  let last = 'no response';
  do {
    attempts += 1;
    const r = await get(url, Math.min(opts.intervalMs * 5, 5_000));
    if (r && r.status >= 200 && r.status < 300) return { healthy: true, detail: `HTTP ${r.status} after ${attempts} attempts` };
    last = r ? `HTTP ${r.status}` : 'no response';
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  } while (Date.now() < deadline);
  return { healthy: false, detail: `${last} after ${attempts} attempts (${opts.timeoutMs} ms)` };
}

/** The plan's image may already carry a tag ('client-management:latest'); the run's tag replaces it, since
 * 'name:latest:<sha>' is not a valid reference (seen live on 1387253335-001-r13). A registry port
 * ('host:5000/name') is left alone: only a colon after the last path segment is a tag. */
export function imageName(image: string): string {
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  return colon > slash ? image.slice(0, colon) : image;
}
export const imageRef = (intent: DeploymentIntent) => `${imageName(intent.image)}:${intent.tag}`;

/**
 * Spec Phase 5: validate → build → apply → verify → smoke. Any failure from apply on rolls back to the
 * previous version (when one exists), re-verifies health and confirms the previous image is the one
 * running, so the environment is known-good before the failure is reported and the fix goes through a PR.
 * Nothing here rejects: every path ends in a DeployResult.
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
  // Read before apply: a compose up that fails has already replaced the containers that ran.
  let previous: string | null = await target.currentImage(intent).catch(() => null);
  const fail = async (stage: DeployStage, detail: string): Promise<DeployResult> => {
    if (!previous) {
      // First deploy: nothing to go back to, and the failed stack must not keep running (R8.2).
      try {
        await target.destroy(intent);
        return { ok: false, stage, detail: `${detail}; first deploy failed, the new stack was torn down`, rolledBack: false, rollbackHealthy: null };
      } catch (err) {
        return { ok: false, stage, detail: `${detail}; teardown of the failed first deploy failed: ${(err as Error).message}`, rolledBack: false, rollbackHealthy: null };
      }
    }
    try {
      await target.rollback(intent, previous);
    } catch (err) {
      return { ok: false, stage, detail: `${detail}; rollback failed: ${(err as Error).message}`, rolledBack: false, rollbackHealthy: false };
    }
    try {
      const back = await target.verify(intent);
      const running = await target.currentImage(intent);
      if (running !== previous) {
        return { ok: false, stage, detail: `${detail}; after rollback ${running ?? 'nothing'} is running instead of ${previous}`, rolledBack: true, rollbackHealthy: false };
      }
      return { ok: false, stage, detail, rolledBack: true, rollbackHealthy: back.healthy };
    } catch (err) {
      return { ok: false, stage, detail: `${detail}; rollback verify failed: ${(err as Error).message}`, rolledBack: true, rollbackHealthy: false };
    }
  };
  try {
    previous = (await target.apply(intent)).previous;
  } catch (err) {
    if (previous) return fail('apply', (err as Error).message);
    return { ok: false, stage: 'apply', detail: (err as Error).message, rolledBack: false, rollbackHealthy: null };
  }
  let health: { healthy: boolean; detail: string };
  try {
    health = await target.verify(intent);
  } catch (err) {
    return fail('verify', (err as Error).message);
  }
  if (!health.healthy) return fail('verify', health.detail);
  const smoke = await deps.smoke(deps.baseUrl);
  if (!smoke.ok) return fail('smoke', smoke.detail);
  return { ok: true, previous };
}
