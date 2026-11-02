import type { LastDeploy, ServiceStatus, SpecState, TaskState } from '../../api.js';

export const KIND_LABEL: Record<string, string> = { api: 'API', jobs: 'Workers', web: 'Web', mobile: 'Mobile', workflow: 'Workflow', monolith: 'Monólito' };

export const SPEC_STATE: Record<SpecState, { label: string; tone: string }> = {
  delivered: { label: 'Entregue', tone: 'good' },
  awaiting: { label: 'Aguarda validação', tone: 'neutral' },
  failed: { label: 'Falhou', tone: 'bad' },
  blocked: { label: 'Bloqueado', tone: 'warn' },
  running: { label: 'Em desenvolvimento', tone: '' },
  pending: { label: 'Pendente', tone: '' },
  'not-started': { label: 'Não iniciado', tone: '' },
};

/** The order the delivery board lists the groups in: what needs the owner first, delivered last. */
export const SPEC_ORDER: SpecState[] = ['awaiting', 'failed', 'blocked', 'running', 'pending', 'not-started', 'delivered'];

export const TASK_STATE: Record<TaskState, { label: string; tone: string }> = {
  delivered: { label: 'Entregue', tone: 'good' },
  running: { label: 'Em desenvolvimento', tone: '' },
  pending: { label: 'Pendente', tone: '' },
  blocked: { label: 'Bloqueada', tone: 'warn' },
  failed: { label: 'Falhou', tone: 'bad' },
};

export const RUN_KIND_LABEL: Record<string, string> = { run: 'Execução', complete: 'Conclusão', readme: 'README', deploy: 'Deploy' };

/** The address of the repository's own service, or of the one service of a single-service deploy. */
export function addressOf(repo: string, deploy: LastDeploy): { url: string | null; docsPath: string | null; service: string | null } {
  const own = deploy.services?.find((s) => s.service === repo) ?? null;
  if (own) return { url: own.url, docsPath: own.docsPath, service: own.service };
  return { url: deploy.url, docsPath: deploy.docsPath, service: null };
}

/** The live answer for the address: the service's own entry when the deploy has several services. */
export function answerOf(repo: string, deploy: LastDeploy, probe: ServiceStatus): { ui: boolean; docs: boolean } {
  const own = deploy.services ? probe.services?.find((s) => s.service === repo) : undefined;
  if (own) return { ui: own.ui === true, docs: own.docs === true };
  return { ui: probe.ui === true, docs: probe.docs === true };
}
