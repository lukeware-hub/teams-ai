import type { LastDeploy, ServiceStatus } from '../../api.js';
import { addressOf, answerOf } from './labels.js';

export interface Shortcut {
  kind: 'swagger' | 'app';
  href: string;
}

/** A path on the service's address, or null when either part is missing or the address is not a URL. */
function joinAddress(url: string | null, path: string | null): string | null {
  if (!url || !path) return null;
  try {
    return new URL(path, url).href;
  } catch {
    return null;
  }
}

/** The shortcuts the repository's kind offers, each only while the live probe answers for it. */
export function shortcutsOf(kind: string | null, repo: string, deploy: LastDeploy | null, probe: ServiceStatus | null): Shortcut[] {
  if (!deploy || !probe?.online) return [];
  const address = addressOf(repo, deploy);
  const answer = answerOf(repo, deploy, probe);
  const swagger = answer.docs ? joinAddress(address.url, address.docsPath) : null;
  const app = answer.ui && address.url ? address.url : null;
  const out: Shortcut[] = [];
  if (swagger && (kind === 'api' || kind === 'jobs' || kind === 'monolith')) out.push({ kind: 'swagger', href: swagger });
  if (app && (kind === 'web' || kind === 'monolith')) out.push({ kind: 'app', href: app });
  return out;
}

/** True when the deploy exists and the probe says the system is not answering. */
export function isOffline(deploy: LastDeploy | null, probe: ServiceStatus | null): boolean {
  return deploy !== null && probe !== null && !probe.online;
}
