import type { CostPeriod, CostStage } from '@server/usage/cost-types.js';
import { ROLE_LABEL } from '../../run/roles.js';

export const PERIOD_LABEL: Record<CostPeriod, string> = { hoje: 'Hoje', '7d': '7 dias', '30d': '30 dias', tudo: 'Tudo' };
export const STAGE_LABEL: Record<CostStage, string> = { refinement: 'Refinamento', development: 'Desenvolvimento', chat: 'Chat' };
/** The agent roles, plus the decision models that stand in for a role. */
export const AGENT_LABEL: Record<string, string> = { ...ROLE_LABEL, jev: 'Jev', local: 'Modelo local', escalonamento: 'Escalonamento para Claude' };
export const KIND_LABEL: Record<string, string> = {
  resposta: 'Resposta do chat',
  'avaliacao-jev': 'Avaliação do Jev',
  'decisao-jev': 'Decisão do Jev',
  'decisao-local': 'Decisão local',
  'decisao-claude': 'Decisão do Claude',
  desconhecido: 'Desconhecido',
};
export const PHASE_LABEL: Record<string, string> = { chat: 'Chat', refine: 'Refinamento', decisao: 'Decisão', desconhecida: 'Desconhecida' };

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
  chat: 'Respostas que falharam não têm custo registrado.',
};
