import type { Benefit, StepPanel } from '../components/ItemCard.js';

export const GH_LOGIN = {
  benefits: [
    { icon: 'lock', title: 'Acesso seguro', text: 'Login oficial do GitHub CLI neste computador.' },
    { icon: 'shield', title: 'Apenas o necessário', text: 'Serve para listar suas organizações e contas.' },
  ] as const satisfies readonly Benefit[],
  panel: {
    headline: 'Conecte o GitHub ao Teams AI',
    support: 'Com o CLI autenticado, a plataforma cria repositórios e abre pull requests no seu fluxo.',
  } satisfies StepPanel,
};

export const GH_TOKEN = {
  benefits: [
    { icon: 'lock', title: 'Publica em seu nome', text: 'O token autoriza criar repositórios e pull requests.' },
    { icon: 'shield', title: 'Fica neste computador', text: 'Guardado só aqui e nunca repassado aos agentes.' },
  ] as const satisfies readonly Benefit[],
  panel: {
    headline: 'Permissão para publicar código',
    support: 'Um token com as permissões certas deixa o orquestrador trabalhar sem pedir login a cada passo.',
  } satisfies StepPanel,
};

export const GH_OWNER = {
  benefits: [
    { icon: 'folder', title: 'Onde nascem os projetos', text: 'Repositórios dos seus projetos ficam nesta organização.' },
    { icon: 'activity', title: 'Análise no lugar certo', text: 'O Teams AI trabalha só nos repositórios dessa conta.' },
  ] as const satisfies readonly Benefit[],
  panel: {
    headline: 'Mais produtividade para o seu time',
    support: 'Escolha a organização onde o Teams AI cria e atualiza os repositórios dos seus projetos.',
  } satisfies StepPanel,
};

export const CLAUDE_LOGIN = {
  benefits: [
    { icon: 'claude', title: 'Conta dos agentes', text: 'Os agentes de refinamento, código e teste usam esta conta.' },
    { icon: 'shield', title: 'Sem ela o time não roda', text: 'Cada etapa precisa do Claude Code autenticado.' },
  ] as const satisfies readonly Benefit[],
  panel: {
    headline: 'Os agentes precisam do Claude',
    support: 'Conecte sua conta para o time de IA trabalhar neste computador com a sua assinatura.',
  } satisfies StepPanel,
};

export const LICENSE = {
  benefits: [
    { icon: 'lock', title: 'Registro único', text: 'A chave ativa este computador uma única vez.' },
    { icon: 'shield', title: 'Não fica salva', text: 'Depois da conferência, a chave não permanece neste computador.' },
  ] as const satisfies readonly Benefit[],
  panel: {
    headline: 'Ative o Teams AI',
    support: 'Informe a chave fornecida pela Lukeware. Ela é conferida agora e não fica salva aqui.',
  } satisfies StepPanel,
};

export const OPENROUTER = {
  benefits: [
    { icon: 'lightbulb', title: 'Jev no refinamento', text: 'Confere se os documentos do projeto são consistentes.' },
    { icon: 'lock', title: 'Gate 1 depende dela', text: 'Sem a chave, o refinamento não inicia.' },
  ] as const satisfies readonly Benefit[],
  panel: {
    headline: 'Chave do OpenRouter',
    support: 'O Jev classifica e decide pontos do Gate 1. Informe a chave para liberar o refinamento.',
  } satisfies StepPanel,
};
