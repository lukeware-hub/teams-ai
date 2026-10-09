// Shared between the project list (Projects.tsx) and the per-project hub (ProjectHub.tsx): status vocabulary,
// chips and small formatters used by both screens' specs and runs rows.
export const CONTINUABLE = new Set(['awaiting-validation', 'done']);
export const ACTIVE = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);
export const RECENT_RUNS = 5;
export const money = (n: number) => `US$ ${n.toFixed(2)}`;
// Thousands split by a narrow space: a dot or a comma would read as a decimal point next to the US$ amounts.
export const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Spec and run states are feminine (a spec, a execução); refinement states masculine (o refinamento).
// 'idle' is not a server status: a spec frozen for running ('running') with no run in progress.
export const LABEL: Record<string, string> = {
  idle: 'pronta para executar', refining: 'em refinamento', planned: 'planejada', running: 'em execução', draining: 'finalizando',
  'paused:quota': 'pausada por cota', 'paused:auth': 'aguardando login', interrupted: 'interrompida', 'awaiting-validation': 'aguardando validação',
  done: 'concluída', complete: 'concluída', drained: 'encerrada', blocked: 'bloqueada', deadlocked: 'travada',
  'phase-failed': 'fase falhou', 'verification-failed': 'verificação falhou', 'deploy-failed': 'deploy falhou', 'launch-failed': 'não iniciou', unknown: 'sem status',
  drafting: 'em edição', evaluating: 'em avaliação', answering: 'aguardando respostas', ready: 'pronto para iniciar', error: 'com erro',
};
export const TONE: Record<string, string> = {
  done: 'good', complete: 'good', ready: 'good',
  running: 'neutral', draining: 'neutral', evaluating: 'neutral',
  'paused:quota': 'warn', 'paused:auth': 'warn', interrupted: 'warn', 'awaiting-validation': 'warn', answering: 'warn',
  blocked: 'bad', deadlocked: 'bad', 'phase-failed': 'bad', 'verification-failed': 'bad', 'deploy-failed': 'bad', 'launch-failed': 'bad', error: 'bad',
};
export const chip = (status: string) => <span className={TONE[status] ? `status-pill tone-${TONE[status]}` : 'status-pill'}>{LABEL[status] ?? status}</span>;

export const HELP = {
  specs: 'Cada spec descreve uma entrega do projeto. O status mostra a etapa: pronta para executar, em execução, pausada, aguardando validação ou concluída. Continuar spec reabre a spec para um novo refinamento.',
  runStatus: 'Pausada por cota: continua sozinha quando o limite de uso renovar. Aguardando login: a sessão do Claude expirou; entre de novo e use Retomar. Interrompida: o processo parou; use Retomar. Finalizando: encerrando depois de Parar.',
  tokens: 'Total de tokens lidos e escritos pelos modelos de IA nesta execução.',
  cost: 'Custo estimado das chamadas aos modelos de IA nesta execução, em dólares.',
  drafts: 'Specs ainda em escrita, antes da execução. Em avaliação: a IA está revisando os documentos. Aguardando respostas: há perguntas ou sugestões para você. Pronto para iniciar: tudo aprovado; abra e inicie a execução.',
};
