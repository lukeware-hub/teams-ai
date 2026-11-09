import type { LastDeploy, ServiceStatus } from '../../api.js';
import { serviceLinks } from '@server/deploy/service-links.js';
import { addressOf, answerOf } from './labels.js';

export interface Shortcut {
  kind: 'swagger' | 'app';
  /** Where the button opens; null while it cannot open. */
  href: string | null;
  /** Why the button cannot open, in words; null when it opens. */
  reason: string | null;
}

/** The buttons a repository of this kind shows: Swagger for an API, a worker or a BFF, the application for a web repository, both for a monolith. */
export function shortcutsOf(kind: string | null, repo: string, deploy: LastDeploy | null, probe: ServiceStatus | null, hostname: string, probeFailed = false): Shortcut[] {
  const wanted: Shortcut['kind'][] = kind === 'api' || kind === 'worker' || kind === 'bff' ? ['swagger'] : kind === 'web' ? ['app'] : kind === 'monolith' ? ['swagger', 'app'] : [];
  return wanted.flatMap((k) => shortcutOf(k, repo, deploy, probe, hostname, probeFailed) ?? []);
}

/** One button: its address when the live answer gives one, else the reason it has none; null when there is nothing to open. */
function shortcutOf(kind: Shortcut['kind'], repo: string, deploy: LastDeploy | null, probe: ServiceStatus | null, hostname: string, probeFailed: boolean): Shortcut | null {
  if (!deploy) return { kind, href: null, reason: 'sem dados: nenhum deploy verificado ainda' };
  const address = addressOf(repo, deploy);
  // The plan declares no documentation page: the Swagger button stays, blocked, with the reason.
  if (kind === 'swagger' && !address.docsPath) return { kind, href: null, reason: 'Swagger não existe' };
  if (kind === 'app' && deploy.kind === 'api') return null;
  if (!probe) return { kind, href: null, reason: probeFailed ? 'não foi possível verificar o sistema' : 'verificando se o sistema responde' };
  if (!probe.online) return { kind, href: null, reason: 'sistema desligado' };
  const answer = answerOf(repo, deploy, probe);
  const links = address.url ? serviceLinks({ url: address.url, docsPath: address.docsPath ?? undefined, kind: 'api' }, hostname) : { appUrl: null, docsUrl: null };
  if (kind === 'swagger') {
    if (!answer.docs) return { kind, href: null, reason: 'a documentação não responde' };
    return links.docsUrl ? { kind, href: links.docsUrl, reason: null } : { kind, href: null, reason: 'a porta do serviço não está publicada' };
  }
  if (!answer.ui) return { kind, href: null, reason: 'a aplicação não responde na raiz' };
  return links.appUrl ? { kind, href: links.appUrl, reason: null } : { kind, href: null, reason: 'a porta do serviço não está publicada' };
}

/** True when the deploy exists and the probe says the system is not answering. */
export function isOffline(deploy: LastDeploy | null, probe: ServiceStatus | null): boolean {
  return deploy !== null && probe !== null && !probe.online;
}

/** The address that opens the running system: its health path, so an API answers with a page; null while the system is down or its port is not published. */
export function systemHrefOf(repo: string, deploy: LastDeploy | null, probe: ServiceStatus | null, hostname: string): string | null {
  if (!deploy || !probe?.online) return null;
  const address = addressOf(repo, deploy);
  if (!address.url) return null;
  const { appUrl } = serviceLinks({ url: address.url, kind: 'api' }, hostname);
  return appUrl ? `${appUrl}${address.healthcheckPath ?? ''}` : null;
}
