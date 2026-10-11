import { randomInt } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { updateFileAtomic } from '../core/atomic-write.js';
import type { Exec } from '../exec/command.js';
import { PUBLISHED_PORTS } from './service-links.js';

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

/** True when a container outside the compose project already publishes the host port. */
export async function portHeldByOthers(exec: Exec, composeProject: string, port: number): Promise<boolean> {
  const r = await exec({ bin: 'docker', args: ['ps', '--format', '{{.Label "com.docker.compose.project"}}|{{.Ports}}'], timeoutMs: 30_000 }).catch(() => null);
  return (r?.stdout ?? '').split('\n').some((line) => !line.startsWith(`${composeProject}|`) && line.includes(`:${port}->`));
}

async function updateRegistry(workspacesRoot: string, update: (registry: Record<string, number>) => Record<string, number>): Promise<void> {
  await fs.mkdir(workspacesRoot, { recursive: true });
  await updateFileAtomic(registryFile(workspacesRoot), (text) => `${JSON.stringify(update(parseRegistry(text)), null, 2)}\n`);
}

/**
 * Every project publishes on the same host range, so each gets its own random port, kept in a registry until the project
 * is deleted (live: node-hello-api planned 3000 while an old container still held it). A registered port stays with its
 * project; a new one is drawn from the range, skipping other projects' ports and ports the daemon already publishes.
 * `avoid` ports are never kept or drawn (a port that turned out to be held). `port` is null when the range is full;
 * `taken` are the ports the plan must not use.
 */
export async function assignDeployPort(workspacesRoot: string, projectId: string, exec: Exec, avoid: number[] = []): Promise<{ port: number | null; taken: number[] }> {
  const busy = await busyPorts(exec);
  let result = { port: null as number | null, taken: [] as number[] };
  await updateRegistry(workspacesRoot, (registry) => {
    const others = Object.entries(registry).filter(([id]) => id !== projectId).map(([, port]) => port);
    const taken = [...new Set([...others, ...busy, ...avoid])].sort((a, b) => a - b);
    const inRange = (p: number) => p >= PUBLISHED_PORTS.from && p <= PUBLISHED_PORTS.to;
    const free = Array.from({ length: PUBLISHED_PORTS.to - PUBLISHED_PORTS.from + 1 }, (_, i) => PUBLISHED_PORTS.from + i).filter((p) => !taken.includes(p));
    const own = registry[projectId];
    const port = own !== undefined && inRange(own) && !others.includes(own) && !avoid.includes(own) ? own : (free.length > 0 ? free[randomInt(free.length)]! : null);
    // The project's own running container publishes its own port; that is not "another project's".
    result = { port, taken: taken.filter((p) => p !== port) };
    return port === null ? registry : { ...registry, [projectId]: port };
  });
  return result;
}

/** Every registered port by key; empty before the first one. */
export const registeredPorts = async (workspacesRoot: string): Promise<Record<string, number>> =>
  parseRegistry(await fs.readFile(registryFile(workspacesRoot), 'utf8').catch(() => undefined));

/** The registry key of a project's port, or of one of its services' ports. */
export const portKey = (projectId: string, service: string | null): string => (service === null ? projectId : `${projectId}/${service}`);

/** Gives back the ports of the project and of its services; called when the project is deleted. */
export const releaseDeployPort = (workspacesRoot: string, projectId: string): Promise<void> =>
  updateRegistry(workspacesRoot, (registry) => Object.fromEntries(Object.entries(registry).filter(([key]) => key !== projectId && !key.startsWith(`${projectId}/`))));
