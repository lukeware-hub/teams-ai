import { randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { updateFileAtomic } from '../core/atomic-write.js';
import type { Exec } from '../exec/command.js';

/** Host ports the platform publishes from the nested daemon to the host loopback (docker-compose.yml, dind `ports`). */
export const PUBLISHED_PORTS = { from: 20000, to: 20099 } as const;

/** Range older runs deployed on; still published so their links keep working. */
const LEGACY_PORTS = { from: 3000, to: 3019 } as const;

const registryFile = (workspacesRoot: string) => path.join(workspacesRoot, '.ports.json');

function parseRegistry(text: string | undefined): Record<string, number> {
  try {
    return text === undefined ? {} : (JSON.parse(text) as Record<string, number>);
  } catch {
    return {};
  }
}

/** Host ports the daemon already publishes, whoever started the container. */
async function busyPorts(exec: Exec): Promise<number[]> {
  const r = await exec({ bin: 'docker', args: ['ps', '--format', '{{.Ports}}'], timeoutMs: 30_000 }).catch(() => null);
  return [...(r?.stdout ?? '').matchAll(/:(\d+)->/g)].map((m) => Number(m[1]));
}

async function updateRegistry(workspacesRoot: string, update: (registry: Record<string, number>) => Record<string, number>): Promise<void> {
  await fs.mkdir(workspacesRoot, { recursive: true });
  await updateFileAtomic(registryFile(workspacesRoot), (text) => `${JSON.stringify(update(parseRegistry(text)), null, 2)}\n`);
}

/**
 * Every project publishes on the same host range, so each gets its own random port, kept in a registry until the project
 * is deleted (live: node-hello-api planned 3000 while an old container still held it). A registered port stays with its
 * project; a new one is drawn from the range, skipping other projects' ports and ports the daemon already publishes.
 * `port` is null when the range is full; `taken` are the ports the plan must not use.
 */
export async function assignDeployPort(workspacesRoot: string, projectId: string, exec: Exec): Promise<{ port: number | null; taken: number[] }> {
  const busy = await busyPorts(exec);
  let result = { port: null as number | null, taken: [] as number[] };
  await updateRegistry(workspacesRoot, (registry) => {
    const others = Object.entries(registry).filter(([id]) => id !== projectId).map(([, port]) => port);
    const taken = [...new Set([...others, ...busy])].sort((a, b) => a - b);
    const inRange = (p: number) => p >= PUBLISHED_PORTS.from && p <= PUBLISHED_PORTS.to;
    const free = Array.from({ length: PUBLISHED_PORTS.to - PUBLISHED_PORTS.from + 1 }, (_, i) => PUBLISHED_PORTS.from + i).filter((p) => !taken.includes(p));
    const own = registry[projectId];
    const port = own !== undefined && inRange(own) && !others.includes(own) ? own : (free.length > 0 ? free[randomInt(free.length)]! : null);
    result = { port, taken };
    return port === null ? registry : { ...registry, [projectId]: port };
  });
  return result;
}

/** Gives the project's port back; called when the project is deleted. */
export const releaseDeployPort = (workspacesRoot: string, projectId: string): Promise<void> =>
  updateRegistry(workspacesRoot, ({ [projectId]: _released, ...rest }) => rest);

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
  const published = [PUBLISHED_PORTS, LEGACY_PORTS].some((r) => port !== null && port >= r.from && port <= r.to);
  if (port === null || !published) return { appUrl: null, docsUrl: null };
  const appUrl = `http://${hostname}:${port}`;
  return { appUrl, docsUrl: service.kind === 'api' && service.docsPath ? `${appUrl}${service.docsPath}` : null };
}
