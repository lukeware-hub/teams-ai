// Shared between the project list (Projects.tsx) and the per-project hub (ProjectHub.tsx): status vocabulary,
// chips and small formatters used by both screens' specs and runs rows.
// A concluded spec is read-only: the next delivery is a new spec.
export const CONTINUABLE = new Set(['awaiting-validation']);
export const ACTIVE = new Set(['running', 'paused:quota', 'paused:auth', 'draining']);
export const RECENT_RUNS = 5;
export const money = (n: number) => `US$ ${n.toFixed(2)}`;
// Thousands split by a narrow space: a dot or a comma would read as a decimal point next to the US$ amounts.
export const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const when = (at: string | null) => (at ? new Date(at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const KIND_NAME: Record<string, string> = { run: 'Execução', complete: 'Conclusão', deploy: 'Deploy', readme: 'README' };
export const runName = (r: { kind: string; n: number }) => `${KIND_NAME[r.kind] ?? 'Execução'} #${r.n}`;

// Spec and run states are feminine (a spec, a execução); refinement states masculine (o refinamento).
// 'idle' is not a server status: a spec frozen for running ('running') with no run in progress.
export const LABEL: Record<string, string> = {
  idle: 'pronta para executar', refining: 'em refinamento', planned: 'planejada', retired: 'retirada', running: 'em execução', draining: 'finalizando',
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
// Compact row controls: the button, .secondary and .primary primitives supply the colors and hover grounds.
const actionBase = 'inline-flex h-8 min-h-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-[0.8125rem] font-semibold no-underline transition-colors duration-[var(--duration-fast)] pointer-coarse:h-[var(--control-height)]';
export const action = {
  plain: actionBase,
  secondary: `secondary ${actionBase}`,
  primary: `primary ${actionBase}`,
  danger: `${actionBase} border-bad-line text-bad hover:not-disabled:border-bad hover:not-disabled:bg-bad-soft [&+*]:ml-1`,
};
export const panel = 'card grid px-6 pt-5 pb-6 max-md:p-4';
export const sectionTitle = 'flex min-w-0 items-center gap-1';
export const sectionHeading = 'm-0 text-[0.875rem] font-semibold tracking-normal text-ink normal-case';
export const emptyState = 'grid justify-items-center gap-1 rounded-lg border border-line bg-surface-sunken px-6 py-10 text-center text-ink-faint [&_svg]:mb-2 [&_p]:m-0 [&_p]:max-w-[52ch] [&_p]:text-ink [&_p+p]:text-ink-soft [&_button]:mt-3';
// Spec and draft rows share the list's columns, so ids, chips and actions line up; the list bleeds into the panel padding.
export const rows = 'my-0 -mx-[0.6rem] grid list-none grid-cols-[minmax(0,16rem)_minmax(max-content,1fr)_auto] gap-x-3 p-0 max-lg:grid-cols-[minmax(0,1fr)_auto]';
export const row = 'col-span-full grid min-h-12 grid-cols-subgrid items-center gap-y-2 border-b border-line px-[0.6rem] py-2 last:border-b-0 hover:bg-surface-sunken [&>.status-pill]:justify-self-start';
export const rowId = 'min-w-0 text-[0.875rem] font-medium text-ink wrap-anywhere';
export const rowActions = 'flex justify-end gap-2 max-lg:col-span-full max-lg:flex-wrap max-lg:justify-start';

export const chip = (status: string) =><span className={TONE[status] ? `status-pill tone-${TONE[status]}` : 'status-pill'}>{LABEL[status] ?? status}</span>;

export const HELP = {
  services: 'Cada serviço tem o seu repositório no GitHub. A plataforma são os contêineres que todos os serviços usam, como um broker de mensagens.',
  specs: 'Cada spec descreve uma entrega do projeto. O status mostra a etapa: pronta para executar, em execução, pausada, aguardando validação ou concluída. Continuar spec reabre uma spec aguardando validação para um novo refinamento. Reiniciar descarta a sessão de refinamento atual e recomeça do zero. Uma spec concluída fica somente leitura; a próxima entrega começa em Nova spec.',
  runStatus: 'Pausada por cota: continua sozinha quando o limite de uso renovar. Aguardando login: a sessão do Claude expirou; entre de novo e use Retomar. Interrompida: o processo parou; use Retomar. Finalizando: encerrando depois de Parar.',
  tokens: 'Total de tokens lidos e escritos pelos modelos de IA nesta execução.',
  cost: 'Custo estimado das chamadas aos modelos de IA nesta execução, em dólares.',
  drafts: 'Specs ainda em escrita, antes da execução. Em avaliação: a IA está revisando os documentos. Aguardando respostas: há perguntas ou sugestões para você. Pronto para iniciar: tudo aprovado; abra e inicie a execução.',
};
