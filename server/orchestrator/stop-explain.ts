/**
 * Plain-language explanations of why a run or a task stopped: the rule that names the cause, who must act and the next step.
 * Shared by the run screens (web) and the project chat (server). Pure functions only, with no Node module, so the web bundle can import it.
 */

/** The part of a journal event these explanations read; a stored event has more fields. */
export interface JournalEvent {
  type: string;
  data: Record<string, unknown>;
}

const PHASE_NAMES: Record<number, string> = { 0: 'Preparação do repositório', 1: 'Especificação técnica', 2: 'Plano', 3: 'Implementação', 4: 'Verificação', 5: 'Deploy', 6: 'Relatório', 7: 'Workflows de CI' };

/** "4 · Verificação". The CI workflows (7) are published between phases 2 and 3, so their number would only mislead. */
export function phaseTitle(phase: number): string {
  const name = PHASE_NAMES[phase];
  if (!name) return `Fase ${phase}`;
  return phase <= 6 ? `${phase} · ${name}` : name;
}

export interface DeployFailure {
  attempt: number;
  stage: string;
  detail: string;
  rolledBack: boolean;
  rollbackHealthy: boolean | null;
  /** The service that failed, in a services run. */
  service?: string;
}

/** The latest deploy failure, or null when nothing failed or a later attempt verified. */
export function lastDeployFailure(events: readonly JournalEvent[]): DeployFailure | null {
  let out: DeployFailure | null = null;
  for (const e of events) {
    if (e.type === 'DEPLOY_FAILED') out = { attempt: Number(e.data.attempt), stage: String(e.data.stage), detail: String(e.data.detail ?? ''), rolledBack: e.data.rolledBack === true, rollbackHealthy: typeof e.data.rollbackHealthy === 'boolean' ? e.data.rollbackHealthy : null, ...(typeof e.data.service === 'string' ? { service: e.data.service } : {}) };
    if (e.type === 'DEPLOY_VERIFIED') out = null;
  }
  return out;
}

/** Task-block reasons come straight from the orchestrator in English; translate the ones a user needs
 * to actually read (a plain dependency cascade isn't worth surfacing on its own — see rootBlockers). */
export function explainBlockReason(reason: string): string {
  const scope = reason.match(/^Scope violation:\n([\s\S]*)$/);
  if (scope) return `Violação de escopo: ${scope[1]!.replace(/^frozen files modified: /, 'arquivos protegidos foram alterados: ')}`;
  if (reason === 'a dependency is blocked') return 'uma dependência desta tarefa está bloqueada';
  return reason;
}

export type StopOwner = 'Sistema' | 'Plano' | 'Você';
export interface StopExplanation {
  title: string;
  hint: string;
  owner: StopOwner;
}

// First match wins. Reasons are the orchestrator's English strings (server/orchestrator/task-runner.ts, phases/*.ts);
// the anchored ones come first so a failure that quotes an agent's text is matched by its own prefix.
/** Variable names a failure text cites (A_B style), without the ones the platform itself provides to every suite. */
export function citedVariables(text: string, max = 6): string[] {
  const names = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return [...new Set(names)].filter((n) => !/^(SERVICE_URL(_\w+)?|TEAMS_AI_IMAGE|AC_\d+)$/.test(n)).slice(0, max);
}

const CREDENTIAL_HINT = (names: string[]) =>
  `${names.length > 0 ? `O deploy ou os testes pedem ${names.join(', ')}, que não existem no ambiente.` : 'O deploy ou os testes pedem uma variável de ambiente que não existe.'} Se for uma credencial interna do projeto, como um token de administração entre serviços, liste o nome em environment.generatedSecrets no config.json da plataforma: ela cria o valor sozinha. Se for um valor de terceiros, grave um arquivo com o nome dele em workspaces/<projeto>/secrets. Depois use "Tentar de novo".`;

type StopRule = [RegExp, StopExplanation | ((match: RegExpMatchArray, text: string) => StopExplanation)];
const STOP_RULES: StopRule[] = [
  [/^gh repo view failed/, { title: 'Não foi possível consultar o repositório no GitHub', hint: 'Confira se o GitHub CLI está autenticado e tem acesso ao repositório, depois reprocesse a spec.', owner: 'Você' }],
  [/^Phase 1 exhausted/, { title: 'A especificação técnica não cobriu todos os critérios de aceitação', hint: 'Deixe mais claros na spec os critérios citados no detalhe técnico e reprocesse.', owner: 'Você' }],
  [/^Phase 2 exhausted/, { title: 'O plano de tarefas não passou na validação', hint: 'Leia o último motivo no detalhe técnico. Se ele apontar algo ambíguo na spec, ajuste e reprocesse.', owner: 'Sistema' }],
  [/^(service \S+: )?rendered \S+ is invalid/, { title: 'Os workflows de CI gerados a partir do plano são inválidos', hint: 'Revise os comandos do plan.json na main e reprocesse a spec.', owner: 'Plano' }],
  [/none of the git remotes configured for this repository point to a known GitHub host/, { title: 'O repositório não tem um remote do GitHub', hint: 'Configure o remote de origem do repositório para um repositório do GitHub e reprocesse a spec.', owner: 'Você' }],
  [/^(service \S+: )?docs merge failed/, { title: 'O PR de documentação não entrou na main', hint: 'Confira as permissões e a proteção de branch do repositório e reprocesse a spec.', owner: 'Você' }],
  [/^Phase 6 blocked: documentation rejected/, { title: 'A documentação gerada no relatório foi rejeitada', hint: 'Reprocesse a spec. Se a falha se repetir, o motivo da rejeição está no detalhe técnico.', owner: 'Sistema' }],
  [/^Phase 6 blocked/, { title: 'O relatório final não foi gerado', hint: 'O Scrum Master não devolveu o relatório no formato esperado. Reprocesse a spec para gerar o relatório de novo.', owner: 'Sistema' }],
  [/^delivery contract not met/, { title: 'Faltam arquivos de entrega na main', hint: 'Veja no detalhe técnico quais arquivos faltaram. Se as tarefas ficaram bloqueadas, use Retomar: elas recomeçam.', owner: 'Sistema' }],
  [/^verification failed in round 2: 0 failing tests, 0 uncovered criteria; gate \S+ failed/, { title: 'Uma verificação obrigatória falhou', hint: 'Todos os critérios passaram, mas um gate obrigatório, como lint, tipos, cobertura ou segurança, falhou. Veja a saída dele no detalhe técnico e reprocesse a spec.', owner: 'Sistema' }],
  [/^verification failed in round 2: 0 failing tests, [1-9]\d* uncovered/, { title: 'Critérios de aceitação ficaram sem evidência', hint: 'Nenhum teste falhou, mas critérios ficaram sem teste aprovado, quase sempre porque as tarefas deles bloquearam. Veja os bloqueios na lista de tarefas e reprocesse a spec.', owner: 'Sistema' }],
  [/^verification failed in round 2/, { title: 'Os testes de aceitação não passaram', hint: 'Veja na matriz de evidências quais critérios falharam e reporte o problema na tela de validação.', owner: 'Sistema' }],
  [/^fix-tasks rejected twice/, { title: 'O Scrum Master não conseguiu planejar as correções', hint: 'Leia o motivo no detalhe técnico e reprocesse a spec.', owner: 'Sistema' }],
  [/plan\.commands\.smoke missing/, { title: 'O plano não define commands.smoke', hint: 'Falta o comando dos testes de fumaça no plan.json. Nenhum agente edita o plano durante a run: adicione commands.smoke ao plano na main e tente de novo.', owner: 'Plano' }],
  [/produced no changes against origin\/main/, { title: 'O Dev disse que terminou, mas não alterou nada', hint: 'A tarefa não gerou diferença em relação à main. Costuma ser um problema que código não resolve (ex.: um campo faltando no plano); repetir a tarefa só gasta tokens.', owner: 'Sistema' }],
  [/^Scope violation:/, { title: 'O Dev mexeu em arquivos fora do escopo da tarefa', hint: 'A mudança foi rejeitada antes do merge. Revise os caminhos permitidos da tarefa no plano.', owner: 'Sistema' }],
  [/^spec-gap rounds exhausted/, { title: 'O Dev continuou com dúvidas sobre a spec', hint: 'O Scrum Master respondeu três vezes e a dúvida persiste. Esclareça o ponto na spec e inicie uma nova execução.', owner: 'Você' }],
  [/^Security review requested changes/, { title: 'A revisão de segurança pediu mudanças', hint: 'Faça os ajustes de segurança pedidos na tarefa e reprocesse a spec.', owner: 'Sistema' }],
  [/^Review requested changes/, { title: 'A revisão de código pediu mudanças', hint: 'Faça os ajustes pedidos na tarefa e reprocesse a spec.', owner: 'Sistema' }],
  [/^Review evidence rejected/, { title: 'A evidência da revisão foi rejeitada', hint: 'O revisor citou testes que não aparecem no relatório de testes. Veja o texto técnico e reprocesse a spec.', owner: 'Sistema' }],
  [/^Rebase conflicts/, { title: 'Conflito com uma mudança que já está na main', hint: 'Resolva o conflito nos arquivos listados no texto técnico e reprocesse a spec.', owner: 'Sistema' }],
  [/^Merge (refused|queue)/, { title: 'O merge foi recusado', hint: 'O GitHub ou a fila de merge recusou a mudança várias vezes. Confira permissões e proteção de branch do repositório.', owner: 'Você' }],
  [/^Task token budget exceeded/, { title: 'A tarefa estourou o orçamento de tokens', hint: 'Divida a tarefa em partes menores no plano ou aumente o limite por tarefa.', owner: 'Sistema' }],
  [/^replan (rejected|failed)/, { title: 'O replanejamento da tarefa falhou', hint: 'O Scrum Master não conseguiu dividir a tarefa. Veja o detalhe técnico.', owner: 'Sistema' }],
  [/^depends on (\S+?),? which (?:failed|is blocked)/, (m) => ({ title: `Aguarda a spec ${m[1]}`, hint: `Esta spec só começa quando ${m[1]} for entregue. Resolva a falha dela primeiro e use "Tentar de novo" nela: esta segue sozinha.`, owner: 'Você' })],
  [/required variable|is missing a value|missing secret|não foram? definid|not (?:been )?defined|is not set/i, (_m, text) => ({ title: 'Falta uma credencial ou variável de ambiente', hint: CREDENTIAL_HINT(citedVariables(text)), owner: 'Você' })],
  [/is unhealthy|dependency failed to start/, { title: 'Um container do deploy não ficou saudável', hint: 'Um container do deploy reiniciou ou não passou no healthcheck. As últimas linhas de log dele estão no detalhe técnico, e a próxima tentativa já as recebe.', owner: 'Sistema' }],
  [/no such host|ENOTFOUND|was never published|name does not resolve/i, { title: 'Um serviço de outra spec não está acessível', hint: 'Os testes precisam de um serviço entregue por outra spec que não está no ar. Entregue ou reinicie essa spec primeiro.', owner: 'Você' }],
  [/^Gates failed after rebase/, { title: 'Uma verificação falhou depois de atualizar a tarefa com a main', hint: 'Veja no texto técnico qual verificação falhou e reprocesse a spec.', owner: 'Sistema' }],
  [/^Rebase stage failed without conflicts/, { title: 'A tarefa não conseguiu se atualizar com a main', hint: 'O git falhou sem conflito de arquivos. Veja o texto técnico e reprocesse a spec.', owner: 'Sistema' }],
  [/^The Dev changed nothing again/, { title: 'O Dev não alterou nada, mesmo depois da resposta do Scrum Master', hint: 'Veja no texto técnico a última resposta do Scrum Master e reprocesse a spec.', owner: 'Sistema' }],
  [/^filesRead leaves out source files/, { title: 'O Dev não leu todos os arquivos que ia alterar', hint: 'Ele precisa ler cada arquivo listado no texto técnico antes de mudar o código. Reprocesse a spec para tentar de novo.', owner: 'Sistema' }],
  [/^Security review incomplete/, { title: 'A revisão de segurança precisou de uma ferramenta que não está disponível', hint: 'Veja no texto técnico qual ferramenta faltou e reprocesse a spec.', owner: 'Sistema' }],
  [/^(skill-select failed|skill request repeated)/, { title: 'O ambiente não encontrou a ferramenta que a tarefa pediu', hint: 'Veja no texto técnico qual ferramenta faltou e reprocesse a spec.', owner: 'Sistema' }],
  [/^Orchestrator step failed/, { title: 'Um passo da execução falhou por erro interno', hint: 'Veja no texto técnico a causa e reprocesse a spec.', owner: 'Sistema' }],
  [/^Gate install failed \(\w+, exit -?\d+\)/, { title: 'A instalação das dependências falhou na verificação', hint: 'O ambiente de verificação não instalou o que o projeto pede: confira no texto técnico a versão ou o pacote que faltou e reprocesse a spec. Se a versão for de uma ferramenta do ambiente, a correção é na imagem da plataforma.', owner: 'Sistema' }],
  [/^Gate (\S+) failed \(\w+, exit -?\d+\)/, (m) => ({ title: `Uma verificação automática falhou: ${m[1]}`, hint: 'Veja no texto técnico quais testes ou checagens quebraram e reprocesse a spec.', owner: 'Sistema' })],
  [/^Run \S+ of spec .* is still live/, { title: 'Outra execução desta spec ainda está rodando', hint: 'Espere a outra execução terminar ou pare-a, depois reprocesse a spec.', owner: 'Você' }],
  [/^a dependency is blocked$/, { title: 'Espera uma tarefa da qual ela depende', hint: 'Ela continua parada até a tarefa da qual depende ser resolvida. Resolva a bloqueada primeiro.', owner: 'Sistema' }],
  // An agent's own words, not an orchestrator string (runs hello-001-r4 and r5): last, so no prefix above is shadowed.
  [/frozenPaths/, { title: 'O plano pede arquivos que ele mesmo protege', hint: 'Uma tarefa precisa criar arquivos que estão em frozenPaths. Tire o caminho de frozenPaths no plano da main (ou da tarefa) e reprocesse: sem isso o Dev bloqueia de novo.', owner: 'Plano' }],
  [/security-tools'? gate/i, { title: 'As ferramentas de segurança não rodam no ambiente do gate', hint: 'O gate security-tools falha antes de analisar o código, e os arquivos dele são protegidos: nenhum agente consegue corrigir. Ajuste a imagem ou o instalador do gate e reprocesse a spec.', owner: 'Sistema' }],
];

/** A pt-BR explanation of a raw stop reason, or null when it is not one the UI knows (callers then show it raw). */
export function explainStop(reason: string): StopExplanation | null {
  for (const [re, explanation] of STOP_RULES) {
    const match = reason.match(re);
    if (match) return typeof explanation === 'function' ? explanation(match, reason) : explanation;
  }
  return null;
}

/** The first sentence of a free-text reason, cut to `max` characters: a one-line title for a long explanation. */
export function firstSentence(text: string, max = 100): string {
  const line = text.trim().split('\n', 1)[0] ?? '';
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const word = cut.lastIndexOf(' ');
  return `${(word > max / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

const NEXT_STEP = 'Veja o detalhe técnico. Quando a causa estiver resolvida, reprocesse a spec.';
const DEPLOY_NEXT_STEP = 'O orquestrador esgotou as tentativas de deploy. Veja o detalhe técnico e os logs do container.';
const AUTONOMOUS_NEXT_STEP = 'Os agentes já tentaram resolver sozinhos. Veja o detalhe técnico.';
const AUTONOMOUS_BLOCKED_HINT = 'Os agentes já decidiram o que podiam e a tarefa não avançou. Veja o detalhe técnico.';

/** With the owner letting the agents decide, no screen offers a reprocess, so a hint that asks for one is replaced. */
export const ownHint = (hint: string, autonomous: boolean): string => (autonomous && /reprocess/i.test(hint) ? AUTONOMOUS_NEXT_STEP : hint);

/** What a failed phase row says: the known explanation of its reason, else the reason's first sentence and a generic next step. */
export function explainPhase(row: { phase: number; reason: string | null }, autonomous = false): StopExplanation {
  const reason = row.reason ?? '';
  const why: StopExplanation = explainStop(reason) ?? { title: reason ? firstSentence(reason) : `${phaseTitle(row.phase)} falhou`, hint: row.phase === 5 ? DEPLOY_NEXT_STEP : NEXT_STEP, owner: 'Sistema' };
  return { ...why, hint: ownHint(why.hint, autonomous) };
}

const SEVERITY_LABEL: Record<string, string> = { critical: 'crítico', high: 'alto', important: 'importante', medium: 'médio', minor: 'menor', low: 'baixo' };
const PROGRESS_LABEL: Record<string, string> = { stalled: 'pararam de avançar', diverging: 'estavam piorando' };
const FINDINGS_HEAD = /^(?:Security review|Review) requested changes:\n/;
const FINDING = /^- (\S+?)(?::(\d+))? \[(\w+)\] ([\s\S]*)$/;
const FIX = /^([\s\S]*?) \(fix: ([\s\S]*)\)$/;
const PROGRESS_TAIL = /\n\nAttempt progress judged (\w+) \([^)]*\) on a replanned task; blocked instead of spending its remaining attempts\.$/;

export interface BlockFinding {
  where: string;
  severity: string;
  problem: string;
  fix: string | null;
}

/** A blocked task's reason in plain words: what happened, the problem, the next step, and the orchestrator's own text. */
export interface BlockExplanation {
  title: string;
  owner: StopOwner;
  problem: string[];
  findings: BlockFinding[];
  next: string;
  raw: string;
}

/** Each "- file:line [severity] problem (fix: …)" line of a review or security block, read into its parts. */
function parseFindings(body: string): BlockFinding[] {
  return body.split(/\n(?=- )/).flatMap((item) => {
    const m = FINDING.exec(item);
    if (!m) return [];
    const [, file, line, severity, rest] = m;
    const fix = FIX.exec(rest!);
    return [{ where: line ? `${file}, linha ${line}` : file!, severity: SEVERITY_LABEL[severity!] ?? severity!, problem: fix ? fix[1]! : rest!, fix: fix ? fix[2]! : null }];
  });
}

/** The plain explanation of a blocked task's reason, for the task and cause dialogs. */
export function blockExplanation(reason: string, autonomous = false): BlockExplanation {
  const tail = PROGRESS_TAIL.exec(reason);
  const main = tail ? reason.slice(0, tail.index) : reason;
  const head = FINDINGS_HEAD.exec(main);
  const translated = explainBlockReason(main);
  const why = explainStop(main) ?? { title: firstSentence(translated), hint: NEXT_STEP, owner: 'Sistema' as StopOwner };
  const problem = [
    ...(!head && translated !== main ? [translated] : []),
    ...(tail ? [`As tentativas ${PROGRESS_LABEL[tail[1]!] ?? 'não avançaram'}. A tarefa já tinha sido refeita uma vez, então foi bloqueada para não gastar as tentativas que faltavam.`] : []),
  ];
  return { title: why.title, owner: why.owner, problem, findings: head ? parseFindings(main.slice(head[0].length)) : [], next: ownHint(why.hint, autonomous), raw: reason };
}

/** One sentence tying a failed run to the tasks that blocked on their own, or null when none did. */
export function blockedSummary(blocked: Array<{ taskId: string; reason: string }>, autonomous = false): string | null {
  const roots = rootBlockers(blocked);
  if (!roots.length) return null;
  const others = blocked.length - roots.length;
  const stuck = others === 1 ? 'outra tarefa' : `outras ${others} tarefas`;
  const single = roots.length === 1;
  const head = single ? `${roots[0]!.taskId} ficou bloqueada` : `${roots.length} tarefas ficaram bloqueadas`;
  const tail = autonomous ? 'Os agentes já tentaram resolver sozinhos.' : single ? 'Sem resolver esse bloqueio, reprocessar tende a repetir a falha.' : 'Sem resolver esses bloqueios, reprocessar tende a repetir a falha.';
  return `${head}${others ? ` e ${single ? 'travou' : 'travaram'} ${stuck}` : ''}. ${tail}`;
}

/** The stop banner's "before that" line; a blocked or deadlocked run's banner already leads with its blocked tasks. */
export function stopBefore(status: string, blocked: Array<{ taskId: string; reason: string }>, autonomous = false): string | null {
  return status === 'blocked' || status === 'deadlocked' ? null : blockedSummary(blocked, autonomous);
}

const STOP_STATUSES = new Set(['deploy-failed', 'verification-failed', 'blocked', 'phase-failed', 'deadlocked', 'failed']);

export interface StopSummary {
  what: string;
  title: string;
  hint: string;
  owner: StopOwner;
  raw: string;
  rollback: string | null;
  action: 'redeploy' | null;
}

/** What the outcome banner says about a run that ended without success, or null while it is fine. */
export function stopSummary(input: { status: string; reason: string | null; causes: Array<{ taskId: string; reason: string }>; deployFailure: DeployFailure | null; failedPhase?: number | null; autonomous?: boolean }): StopSummary | null {
  const { status, reason, causes, deployFailure, autonomous = false } = input;
  if (!STOP_STATUSES.has(status)) return null;
  if (status === 'deploy-failed') {
    const f = deployFailure;
    const raw = f ? f.detail : (reason ?? '');
    const where = f ? `estágio ${f.stage}${f.service ? ` do serviço ${f.service}` : ''}` : '';
    const generic: StopExplanation = { title: f ? `Falha no ${where}` : 'O deploy falhou', hint: DEPLOY_NEXT_STEP, owner: 'Sistema' };
    const why = explainStop(raw) ?? explainStop(reason ?? '') ?? generic;
    const rollback = f?.rolledBack ? (f.rollbackHealthy === false ? 'Rollback feito, mas a versão anterior não respondeu ao healthcheck.' : 'Rollback feito e saudável: a versão anterior continua no ar.') : null;
    return { what: f ? `O deploy falhou no ${where} (tentativa ${f.attempt}).` : 'O deploy falhou.', ...why, hint: ownHint(why.hint, autonomous), raw, rollback, action: 'redeploy' };
  }
  if (status === 'verification-failed') {
    // The verdict is either missing delivery files or failing tests; the reason says which.
    const why = explainStop(reason ?? '');
    return { what: 'A verificação (fase 4) não passou depois de duas rodadas.', title: why?.title ?? 'Os testes de aceitação não passaram', hint: ownHint(why?.hint ?? 'Veja a matriz de evidências abaixo e reporte o problema na tela de validação.', autonomous), owner: why?.owner ?? 'Sistema', raw: reason ?? '', rollback: null, action: null };
  }
  if (status === 'deadlocked') {
    return { what: 'Nenhuma tarefa pode avançar.', title: 'Todas as tarefas restantes dependem de uma tarefa bloqueada', hint: ownHint('Resolva primeiro a tarefa bloqueada (veja Tarefas bloqueadas) e reprocesse a spec.', autonomous), owner: 'Você', raw: reason ?? '', rollback: null, action: null };
  }
  if (status === 'phase-failed' || status === 'failed') {
    const why = explainStop(reason ?? '');
    const where = input.failedPhase === undefined || input.failedPhase === null ? null : phaseTitle(input.failedPhase);
    const what = where ? `A run parou na fase ${where}.` : status === 'failed' ? 'A run falhou.' : 'Uma fase da run falhou.';
    return { what, title: why?.title ?? (reason ? firstSentence(reason) : 'O orquestrador não registrou o motivo'), hint: ownHint(why?.hint ?? NEXT_STEP, autonomous), owner: why?.owner ?? 'Sistema', raw: reason ?? '', rollback: null, action: null };
  }
  const first = causes[0];
  const why = (first ? explainStop(first.reason) : null) ?? { title: first ? firstSentence(explainBlockReason(first.reason)) : 'Tarefas bloqueadas', hint: 'Abra a tarefa para ver o motivo.', owner: 'Sistema' as StopOwner };
  const n = causes.length;
  const hint = autonomous ? AUTONOMOUS_BLOCKED_HINT : ownHint(why.hint, false);
  return { what: n === 1 ? '1 tarefa ficou bloqueada.' : `${n} tarefas ficaram bloqueadas.`, ...why, hint, raw: first?.reason ?? reason ?? '', rollback: null, action: null };
}

/** Every one of `taskIds` currently sitting blocked, with the reason its own TASK_BLOCKED event carries. Unlike
 * `stopSummary`'s `causes` (built from `RUN_FINISHED.blocked`), this works while the run is still active, so a task
 * stuck mid-run shows its cause immediately instead of only once the whole run eventually stops. */
export function liveBlocked(events: JournalEvent[], taskIds: Iterable<string>): Array<{ taskId: string; reason: string }> {
  const reasons = new Map<string, string>();
  for (const e of events) if (e.type === 'TASK_BLOCKED') reasons.set(String(e.data.taskId), String(e.data.reason));
  return [...taskIds].flatMap((taskId) => {
    const reason = reasons.get(taskId);
    return reason === undefined ? [] : [{ taskId, reason }];
  });
}

/** The tasks whose block has its own real cause, filtering out the ones that are only blocked because
 * something upstream failed (a pure dependency cascade, with no diagnostic value of its own). */
export function rootBlockers(blocked: Array<{ taskId: string; reason: string }>): Array<{ taskId: string; reason: string }> {
  return blocked.filter((b) => !isCascade(b));
}

/** The tasks blocked only because a task they depend on is blocked: they wait, and have no cause of their own. */
export function cascadeBlockers(blocked: Array<{ taskId: string; reason: string }>): Array<{ taskId: string; reason: string }> {
  return blocked.filter(isCascade);
}

const isCascade = (b: { reason: string }) => b.reason === 'a dependency is blocked';

/** Tasks blocked for the same reason are one cause, listed once with all their ids, in order. */
export function groupCauses(causes: Array<{ taskId: string; reason: string }>): Array<{ reason: string; taskIds: string[] }> {
  return causes.reduce<Array<{ reason: string; taskIds: string[] }>>((acc, c) => {
    const group = acc.find((g) => g.reason === c.reason);
    if (group) group.taskIds.push(c.taskId);
    else acc.push({ reason: c.reason, taskIds: [c.taskId] });
    return acc;
  }, []);
}
