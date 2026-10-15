# Refinamento: preparar a spec antes de executar

Perguntas que este texto responde: o que é refinamento, como avaliar a spec, o que são as perguntas dos agentes, como responder, o que é a lista de verificação, o que é Avaliar e Reavaliar, quando posso iniciar a execução, o que é Iniciar análise, o que são segredos, o que é o Jev.

O refinamento prepara a spec. Os agentes conferem se a descrição está completa e sem ambiguidade antes de gastar tempo desenvolvendo.

## A tela

- **Documentos do projeto** (à esquerda): cinco documentos que você pode editar: project.md (o projeto), briefing.md (a descrição desta spec), stack.md (as tecnologias), flow.md (o fluxo, em diagrama) e design.md (o visual). As alterações são salvas automaticamente ao sair do editor.
- **Área de revisão** (no meio): o próximo passo, as perguntas dos agentes e as sugestões de ajuste.
- **Lista de verificação** (à direita): o que ainda falta para a spec ficar pronta, o consumo, os arquivos gerados, as tarefas e os segredos.

## Passo a passo

1. Revise os documentos e clique em **Avaliar**. Dois agentes revisam: **Produto** (objetivos, critérios de aceite e fluxo de negócio) e **Técnico** (tecnologias, tarefas e viabilidade).
2. Responda as **perguntas em aberto**. As marcadas como obrigatórias bloqueiam o avanço. Você pode escrever a resposta e clicar em **Responder**, ou **Ignorar** as que não são obrigatórias.
3. Revise as **sugestões de alteração**: aceite ou rejeite cada uma. Aceitar uma sugestão pede nova avaliação.
4. Se mudou algum documento, clique em **Reavaliar**.
5. Quando a lista de verificação estiver toda atendida, aparece "Tudo pronto". Clique em **Iniciar análise** para os agentes desenvolverem.

## Segredos

Se a spec depende de uma chave de outro serviço, a seção **Segredos** guarda o valor. Ela não bloqueia a spec: sem a chave salva, a spec fica pronta, mas o serviço que depende dela pode não funcionar até a chave ser salva. Os agentes nunca veem o valor.

## O Jev

O Jev é uma verificação extra dos documentos, feita por outro serviço. Os pontos que ele aponta são conselhos: ajuste o que fizer sentido e reavalie. Projetos marcados como confidenciais não enviam documentos ao Jev.

## Backlog

Em projetos grandes, o briefing pode virar um backlog com várias specs. O refinamento mostra o backlog para revisão; depois de detalhar, o programa executa as specs em ordem.
