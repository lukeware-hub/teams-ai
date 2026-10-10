import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Host ports the platform publishes from the nested daemon to the host loopback (docker-compose.yml, dind `ports`). */
export const PUBLISHED_PORTS = { from: 3000, to: 3019 } as const;

/** Deploy ports the plans of each project in the workspaces folder use, read from their committed plan.json files. */
async function plannedPorts(projectDir: string): Promise<number[]> {
  const specs = path.join(projectDir, 'repo', 'docs', 'specs');
  const ids = await fs.readdir(specs).catch(() => [] as string[]);
  const ports = await Promise.all(ids.map((id) => fs.readFile(path.join(specs, id, 'plan.json'), 'utf8').then((t) => Number(JSON.parse(t).deploy?.port), () => NaN)));
  return ports.filter((p) => Number.isInteger(p));
}

/**
 * Every project publishes on the same host range, so two projects must never share a deploy port (live: rust-hello-api
 * planned 3000 while custumer-api still ran there). Keeps the port the project already plans with when it is free,
 * else the lowest free one; `port` is null when the range is full.
 */
export async function assignDeployPort(workspacesRoot: string, projectId: string): Promise<{ port: number | null; taken: number[] }> {
  const projects = await fs.readdir(workspacesRoot).catch(() => [] as string[]);
  const taken = [...new Set((await Promise.all(projects.filter((p) => p !== projectId).map((p) => plannedPorts(path.join(workspacesRoot, p))))).flat())].sort((a, b) => a - b);
  const free = (p: number) => p >= PUBLISHED_PORTS.from && p <= PUBLISHED_PORTS.to && !taken.includes(p);
  const own = (await plannedPorts(path.join(workspacesRoot, projectId))).find(free);
  if (own !== undefined) return { port: own, taken };
  for (let p = PUBLISHED_PORTS.from; p <= PUBLISHED_PORTS.to; p++) if (free(p)) return { port: p, taken };
  return { port: null, taken };
}

export interface ServiceInfo {
  url: string;
  port?: number;
  kind?: 'api' | 'front';
  docsPath?: string;
}

export interface ServiceLinks {
  /** Where a browser on the host opens the service, or null when its port is not published. */
  appUrl: string | null;
  docsUrl: string | null;
}

/** Older reports carry only the compose-internal url (http://dind:3000); the port is still in it. */
function portOf(service: ServiceInfo): number | null {
  if (service.port !== undefined) return service.port;
  try {
    const port = Number(new URL(service.url).port);
    return port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** `hostname` is where the UI itself was opened from: the published range listens on the same machine. */
export function serviceLinks(service: ServiceInfo, hostname: string): ServiceLinks {
  const port = portOf(service);
  if (port === null || port < PUBLISHED_PORTS.from || port > PUBLISHED_PORTS.to) return { appUrl: null, docsUrl: null };
  const appUrl = `http://${hostname}:${port}`;
  return { appUrl, docsUrl: service.kind === 'api' && service.docsPath ? `${appUrl}${service.docsPath}` : null };
}
