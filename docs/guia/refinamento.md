# Refinamento: preparar a spec antes de executar

Perguntas que este texto responde: o que é refinamento, como avaliar a spec, o que são as perguntas dos agentes, como responder, o que é a lista de verificação, o que é Avaliar e Reavaliar, quando posso iniciar a execução, o que é Iniciar análise, o que são segredos, o que é o Jev.

O refinamento prepara a spec. Os agentes conferem se a descrição está completa e sem ambiguidade antes de gastar tempo desenvolvendo.

## A tela

- **Documentos do projeto** (à esquerda): cinco documentos que você pode editar: project.md (o projeto), briefing.md (a descrição desta spec), stack.md (as tecnologias), flow.md (o fluxo, em diagrama) e design.md (o visual). As alterações são salvas automaticamente ao sair do editor.
- **Área de revisão** (no meio): o próximo passo, as perguntas dos agentes e as sugestões de ajuste.
- **Lista de verificação** (à direita): o que ainda falta para a spec ficar pronta, o consumo, os arquivos gerados, as tarefas e os segredos.

## Passo a passo

Um projeto novo passa por um processo só, mostrado na barra no topo da tela: **Refinar documentos** e **Backlog**. Depois dele vem **Executar**.

Etapa 1, Refinar documentos:

1. Revise os documentos e clique em **Avaliar**. Dois agentes revisam: **Produto** (objetivos, critérios de aceite e fluxo de negócio) e **Técnico** (tecnologias, tarefas e viabilidade).
2. Responda as **perguntas em aberto**. As marcadas como obrigatórias bloqueiam o avanço. Você pode escrever a resposta e clicar em **Responder**, ou **Ignorar** as que não são obrigatórias.
3. Revise as **sugestões de alteração**: aceite ou rejeite cada uma. Aceitar uma sugestão pede nova avaliação.
4. Se mudou algum documento, clique em **Reavaliar**.
5. Quando a lista de verificação estiver toda atendida, o backlog é montado e detalhado na mesma avaliação. Não há um segundo clique.

Backlog: a avaliação que vem depois dos documentos prontos monta o esboço das specs e gera a spec e o pré-plano de cada item que mudou. Cada avaliação gasta chamadas dos agentes. Uma avaliação roda no máximo quatro rodadas seguidas: para quando precisa de você (uma pergunta ou um erro) ou quando o backlog está pronto. Ao começar o backlog, o briefing passa a ser o `docs/briefing.md` do projeto.

Executar: clique em **Iniciar análise** para os agentes desenvolverem. O botão fica livre a qualquer momento, exceto enquanto os agentes estão avaliando, e nenhuma nota ou lista de verificação o trava. A análise nunca começa sozinha.

Limite de rodadas (variável no `.env`): ao chegar em 50 (`TEAMS_AI_REFINE_MAX_ROUNDS`), **Reavaliar** para e pede uma decisão sua; **Iniciar análise** continua livre. Se o mesmo critério falhar três rodadas seguidas, uma pergunta bloqueante aparece com a divergência.

## Movimentos de conteúdo

Quando um agente encontra um trecho no documento errado (por exemplo, a ordem de passos dentro do design.md), ele move o trecho para o documento certo e avisa no topo da tela. **Desfazer** devolve os dois documentos ao texto anterior, enquanto nenhum deles mudou depois do movimento. **Fechar** só esconde o aviso; o movimento continua valendo.

A cada avaliação, cada documento alterado desde a última avaliação é lido por inteiro e conferido contra as regras de cada documento. Um trecho que claramente pertence a outro documento é movido. Um trecho que pode ficar em mais de um lugar não é movido: vira uma pergunta, com as opções para você escolher. Documentos que não mudaram não são lidos de novo.

## Segredos

Se a spec depende de uma chave de outro serviço, a seção **Segredos** guarda o valor. Ela não bloqueia a spec: sem a chave salva, a spec fica pronta, mas o serviço que depende dela pode não funcionar até a chave ser salva. Os agentes nunca veem o valor.

## O Jev

O Jev é uma verificação extra dos documentos, feita por outro serviço. Os pontos que ele aponta são conselhos: ajuste o que fizer sentido e reavalie. Uma nota abaixo de 80% não impede o início: a análise pode começar mesmo assim. Projetos marcados como confidenciais não enviam documentos ao Jev.

## Backlog

Todo projeto novo tem um backlog: o briefing vira várias specs, ordenadas por prioridade. A avaliação dos documentos prontos monta esse backlog; depois dele, o programa executa as specs em ordem. Uma nova spec ou a continuação de uma spec não passam pelo backlog.
