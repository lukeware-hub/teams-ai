import type { StoredEvent } from '../store/event-store.js';
import { explainBlockReason, firstSentence } from './stop-explain.js';
export type ActivityTone = 'good' | 'bad' | '';
export interface ActivityItem {
  at: string;
  text: string;
  tone: ActivityTone;
  url: string | null;
  /** A task stopped here; counted as a block, not a problem. */
  block?: true;
}

export const STEP_DOING: Record<string, string> = {
  'tech-spec': 'escrevendo a especificação técnica',
  coverage: 'conferindo a cobertura dos critérios de aceite',
  plan: 'montando o plano de tarefas',
  'services-plan': 'montando o plano de tarefas dos serviços',
  dev: 'implementando',
  review: 'revisando o código',
  security: 'revisando a segurança',
  deployment: 'preparando o deploy',
  environment: 'criando o ambiente do teste local',
  report: 'escrevendo o relatório',
  readme: 'escrevendo o README',
  decide: 'tomando uma decisão automática',
  'spec-gap': 'respondendo uma dúvida sobre a spec',
  replan: 'replanejando uma tarefa',
  'fix-tasks': 'criando tarefas de correção',
  architecture: 'decidindo a arquitetura dos repositórios',
};
/** What an agent step kind is doing, in plain words. */
export const stepDoing = (kind: string) => STEP_DOING[kind] ?? kind;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (v: unknown) => (v as string[] | undefined) ?? [];

/** One event as one plain sentence, or null for internal bookkeeping. A confirm reads its own intent's data. */
export function describeEvent(e: StoredEvent, intent: Record<string, unknown> | undefined): Omit<ActivityItem, 'at'> | null {
  const d = e.data;
  const item = (text: string, tone: ActivityTone = '', url: unknown = null) => ({ text, tone, url: typeof url === 'string' ? url : null });
  if (e.kind === 'intent') return e.type === 'WORKTREE_CREATE' && e.intentId?.includes(':docs-') ? item(`Branch ${String(d.branch)} preparada a partir da main`) : null;
  if (e.kind === 'confirm') {
    if (e.type === 'DOCS_COMMIT') {
      const files = list(d.files);
      return item(`Commit ${String(d.sha).slice(0, 7)} na branch ${String(intent?.branch)}: ${String(intent?.message)}${files.length ? ` (${count(files.length, 'arquivo', 'arquivos')})` : ''}`);
    }
    if (e.type === 'PR_MERGE' && !d.merged) return item(`Merge do pull request #${String(intent?.number)} recusado: ${String(d.reason ?? '')}`, 'bad');
    return null;
  }
  switch (e.type) {
    case 'PHASE_STARTED':
      return d.round ? item(`Rodada ${String(d.round)} da verificação iniciada`) : null;
    case 'PHASE_FAILED':
      return item(`A fase falhou: ${firstSentence(String(d.reason ?? ''))}`, 'bad');
    case 'REPO_BOOTSTRAPPED':
      return item(`Repositório ${String(d.fullName)} ${d.created ? 'criado' : 'encontrado'} no GitHub`, 'good', d.url);
    case 'PR_CREATED':
      return item(`Pull request #${String(d.number)} ${d.created ? 'aberto' : 'encontrado'} para a branch ${String(d.branch)}`, '', d.url);
    case 'DOCS_MERGED':
      return item(`Documentação mesclada na main${d.pr ? ` pelo pull request #${String(d.pr)}` : ''}`, 'good');
    case 'TECH_SPEC_WRITTEN': {
      const adrs = list(d.adrs);
      return item(`Especificação técnica escrita em ${String(d.path)}${adrs.length ? `, com ${count(adrs.length, 'ADR', 'ADRs')}` : ''}`);
    }
    case 'COVERAGE_CHECKED': {
      const uncovered = list(d.uncovered);
      return uncovered.length ? item(`${count(uncovered.length, 'critério', 'critérios')} de aceite sem cobertura na especificação técnica: ${uncovered.join(', ')}`, 'bad') : item('Todos os critérios de aceite estão cobertos pela especificação técnica', 'good');
    }
    case 'PLAN_CHOSEN':
      return item(`Plano escolhido: opção ${Number(d.index) + 1} de ${String(d.candidates)}`, 'good');
    case 'PREPLAN_DEVIATION':
      return item(`O plano deixou de fora critérios previstos no pré-plano: ${list(d.missingCriteria).join(', ')}`, 'bad');
    case 'FIX_TASKS_PLANNED':
      return item(count(list(d.tasks).length, 'tarefa de correção criada', 'tarefas de correção criadas'));
    case 'GATE_PASSED':
      return item(`Verificação ${String(d.gate)} passou`, 'good');
    case 'GATE_FAILED':
      return item(`Verificação ${String(d.gate)} falhou`, 'bad');
    case 'VERIFICATION_PASSED':
      return item(`Verificação aprovada na rodada ${String(d.round)}`, 'good');
    case 'VERIFICATION_FAILED': {
      const missing = list(d.missingDelivery);
      const detail = missing.length ? `faltam entregas: ${missing.join(', ')}` : `${count(list(d.failedTests).length, 'teste falhando', 'testes falhando')}, ${count(list(d.uncoveredAcs).length, 'critério sem cobertura', 'critérios sem cobertura')}`;
      return item(`Verificação reprovada na rodada ${String(d.round)}: ${detail}`, 'bad');
    }
    case 'DEPLOY_APPLIED':
      return item(`Deploy aplicado${d.service ? ` em ${String(d.service)}` : ''} (tentativa ${String(d.attempt)})`);
    case 'DEPLOY_FAILED':
      return item(`Deploy falhou${d.service ? ` em ${String(d.service)}` : ''} na etapa ${String(d.stage)} (tentativa ${String(d.attempt)}): ${firstSentence(String(d.detail ?? ''))}`, 'bad');
    case 'ROLLBACK_DONE':
      return item(Array.isArray(d.services) ? `Versão anterior restaurada: ${(d.services as string[]).join(', ')}` : 'Versão anterior restaurada');
    case 'DEPLOY_VERIFIED':
      // A services run lists its services; their addresses are the platform's, not the human's.
      return Array.isArray(d.services) ? item(`Deploy verificado: ${(d.services as Array<{ service: string }>).map((s) => s.service).join(', ')}`, 'good') : item(`Deploy verificado em ${String(d.url)}`, 'good', d.url);
    case 'REPORT_READY':
      return item('Relatório final pronto', 'good');
    case 'PR_MERGED':
      return item(`Tarefa ${String(d.taskId)} mesclada na main${d.pr ? ` (pull request #${String(d.pr)})` : ''}`, 'good');
    case 'REBASE_REPLAYED': {
      const files = list(d.files);
      return item(`Tarefa ${String(d.taskId)} movida para a main atual${files.length ? `, com conflitos a resolver em ${files.join(', ')}` : ', sem conflitos a resolver'}`, files.length ? 'bad' : '');
    }
    case 'TASK_BLOCKED':
      return { ...item(`Tarefa ${String(d.taskId)} bloqueada: ${firstSentence(explainBlockReason(String(d.reason ?? '')))}`, 'bad'), block: true };
    case 'SPEC_GAP_ANSWERED':
      return item(`Tarefa ${String(d.taskId)}: os agentes decidiram: ${firstSentence(String(d.answer ?? ''))}`);
    case 'GATE_FIXED':
      return item(`Tarefa ${String(d.taskId)}: comando da verificação ${String(d.gate)} corrigido (${firstSentence(String(d.reason ?? ''), 80)})`);
    case 'GATE_IMAGE_FIXED':
      return item(`Tarefa ${String(d.taskId)}: imagem das verificações trocada de ${String(d.before)} para ${String(d.after)} (${firstSentence(String(d.reason ?? ''), 80)})`);
    case 'RUN_PAUSED':
      return item(d.reason === 'quota' ? `Execução pausada pelo limite de uso dos modelos${d.until ? ` até ${new Date(String(d.until)).toTimeString().slice(0, 5)}` : ''}` : 'Execução pausada: a sessão do Claude expirou', 'bad');
    case 'RUN_RESUMED':
      return item('Execução retomada');
    case 'STEP_FINISHED':
      return d.ok === false ? item(`Etapa ${stepDoing(String(d.kind))} falhou (${String(d.failure)})`, 'bad') : null;
    default:
      return null;
  }
}

/** Reads every event once, keeping each intent so its confirm can be described. */
export function describeAll(events: StoredEvent[], visit: (e: StoredEvent, item: ActivityItem | null) => void) {
  const intents = new Map<string, Record<string, unknown>>();
  for (const e of events) {
    if (e.kind === 'intent' && e.intentId) intents.set(e.intentId, e.data);
    const item = describeEvent(e, e.intentId ? intents.get(e.intentId) : undefined);
    visit(e, item ? { at: e.at, ...item } : null);
  }
}
