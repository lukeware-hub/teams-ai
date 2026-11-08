import type { CostPeriod, CostStage } from '@server/usage/cost-types.js';
import { ROLE_LABEL } from '../../run/roles.js';

export const PERIOD_LABEL: Record<CostPeriod, string> = { hoje: 'Hoje', '7d': '7 dias', '30d': '30 dias', tudo: 'Tudo' };
export const STAGE_LABEL: Record<CostStage, string> = { refinement: 'Refinamento', development: 'Desenvolvimento', chat: 'Chat' };
/** The agent roles, plus the decision models that stand in for a role. The developer role is named apart from the stage. */
export const AGENT_LABEL: Record<string, string> = {
  ...ROLE_LABEL,
  dev: 'Desenvolvedor',
  jev: 'Jev',
  local: 'Modelo local',
  escalonamento: 'Escalonamento para Claude',
};
/** Every step kind the server runs, and the decision and chat kinds the costs add. */
export const KIND_LABEL: Record<string, string> = {
  refine: 'Refinamento',
  derive: 'Derivação',
  'tech-spec': 'Especificação técnica',
  coverage: 'Cobertura',
  plan: 'Plano',
  'services-plan': 'Plano dos serviços',
  dev: 'Implementação',
  review: 'Revisão',
  security: 'Segurança',
  'ui-check': 'Checagem de interface',
  deployment: 'Deploy',
  environment: 'Ambiente',
  report: 'Relatório',
  gaps: 'Lacunas',
  readme: 'README',
  docs: 'Documentação',
  decide: 'Decisão',
  'spec-gap': 'Lacuna da spec',
  replan: 'Replanejamento',
  'fix-tasks': 'Correções',
  backlog: 'Backlog',
  spec: 'Spec',
  preplan: 'Pré-plano',
  conflicts: 'Conflitos',
  name: 'Nome',
  suggest: 'Sugestão',
  answer: 'Resposta',
  chat: 'Chat',
  'skill-select': 'Seleção de skill',
  speckit: 'Spec Kit',
  converge: 'Convergência',
  'block-options': 'Opções de bloqueio',
  architecture: 'Arquitetura',
  'specs-review': 'Revisão das specs',
  impact: 'Impacto',
  'avaliacao-jev': 'Avaliação do Jev',
  'decisao-jev': 'Decisão do Jev',
  'decisao-local': 'Decisão local',
  'decisao-claude': 'Decisão do Claude',
  resposta: 'Resposta do chat',
  desconhecido: 'Desconhecido',
};
/** The phases of a run, named as the plan names them, plus the stages that have no phase number. */
export const PHASE_LABEL: Record<string, string> = {
  phase1: 'Especificação técnica',
  phase2: 'Plano',
  phase3: 'Tarefas',
  phase4: 'Verificação',
  phase5: 'Deploy e ambiente',
  phase6: 'Relatório',
  phase8: 'Documentação',
  refine: 'Refinamento',
  decisao: 'Decisões automáticas',
  chat: 'Chat',
  desconhecida: 'Desconhecida',
};
/** The models the costs name. A model not listed here shows its own identifier. */
export const MODEL_LABEL: Record<string, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  haiku: 'Haiku (chat)',
  claude: 'Claude (escalonamento)',
  'typesafe/jev-1.13-20260917': 'Jev 1.13',
  'sem modelo': 'Sem modelo',
};

/** The label of a key, or the key itself when no label is known. */
export const labelOf = (labels: Record<string, string>, key: string): string => labels[key] ?? key;

/** The Product Owner answers the chat, so its steps filter under this agent. */
export const CHAT_AGENT = 'po';

export const HELP = {
  total: 'Soma de refinamento, desenvolvimento e chat. Valores estimados a preços de API. No plano de assinatura, o custo não aparece cobrado.',
  refinement: 'Custo dos agentes e do Jev que refinaram documentos e specs, antes do desenvolvimento.',
  development: 'Custo dos agentes que implementam, testam, revisam e publicam as specs, inclusive decisões automáticas.',
  escalation: 'Decisões que o Claude tomou quando o Jev não bastou. O papel que pediu a decisão não fica registrado.',
  resumed: 'Em runs retomados, o total pode ser diferente do custo da tabela de runs.',
  jev: 'Custo do Jev que não pode ser ligado a um projeto, como validações de documentos de projetos apagados.',
  unread: 'Alguns registros não puderam ser lidos: o total pode estar abaixo do real.',
  chat: 'Custo das respostas do chat. Respostas que falharam não têm custo registrado.',
  projects: 'Quanto cada projeto gastou em cada etapa. Clique no nome do projeto para ver os detalhes dele.',
  agents: 'Quanto cada agente custou, dentro da etapa em que trabalhou. A barra mostra a parte dele no total.',
  models: 'Quanto cada modelo de IA custou. A barra mostra a parte dele no total.',
};
