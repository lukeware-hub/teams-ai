/** Host ports the platform publishes from the nested daemon to the host loopback (docker-compose.yml, dind `ports`). */
export const PUBLISHED_PORTS = { from: 20000, to: 20099 } as const;

/** Range older runs deployed on; still published so their links keep working. */
const LEGACY_PORTS = { from: 3000, to: 3019 } as const;

export interface ServiceInfo {
  url: string;
  port?: number;
  kind?: 'api' | 'front' | 'mobile';
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
