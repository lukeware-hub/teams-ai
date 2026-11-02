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

/** The buttons a repository of this kind shows: Swagger for an API or workers, the application for a web repository, both for a monolith. */
export function shortcutsOf(kind: string | null, repo: string, deploy: LastDeploy | null, probe: ServiceStatus | null, hostname: string, probeFailed = false): Shortcut[] {
  const wanted: Shortcut['kind'][] = kind === 'api' || kind === 'jobs' ? ['swagger'] : kind === 'web' ? ['app'] : kind === 'monolith' ? ['swagger', 'app'] : [];
  return wanted.map((k) => shortcutOf(k, repo, deploy, probe, hostname, probeFailed));
}

/** One button: its address when the live answer gives one, else the reason it has none. */
function shortcutOf(kind: Shortcut['kind'], repo: string, deploy: LastDeploy | null, probe: ServiceStatus | null, hostname: string, probeFailed: boolean): Shortcut {
  if (!deploy) return { kind, href: null, reason: 'sem dados: nenhum deploy verificado ainda' };
  if (!probe) return { kind, href: null, reason: probeFailed ? 'não foi possível verificar o sistema' : 'verificando se o sistema responde' };
  if (!probe.online) return { kind, href: null, reason: 'sistema desligado' };
  const address = addressOf(repo, deploy);
  const answer = answerOf(repo, deploy, probe);
  const links = address.url ? serviceLinks({ url: address.url, docsPath: address.docsPath ?? undefined, kind: 'api' }, hostname) : { appUrl: null, docsUrl: null };
  if (kind === 'swagger') {
    if (!address.docsPath) return { kind, href: null, reason: 'o plano não declara a documentação da API' };
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
