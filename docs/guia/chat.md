# Chat de dúvidas

Perguntas que este texto responde: o que é o chat, o que posso perguntar, o chat dá ordens, como limpar a conversa, o chat guarda histórico, o chat abre spec de correção, o chat pesquisa na internet, por que o chat diz que não está registrado.

O **Chat de dúvidas** (ícone de balão no menu lateral) responde em palavras simples sobre o projeto escolhido e sobre como usar o Teams AI.

## O que dá para perguntar

- "O que está sendo desenvolvido agora?"
- "O que está impedindo a entrega de avançar?"
- "Por que a execução parou e o que eu faço?"
- "Quais tarefas estão bloqueadas e por quê?"
- "Algo está sendo feito fora do que foi pedido?"
- "Como crio uma nova spec?"
- Dúvidas sobre o que conversamos antes naquele projeto.

## O que o chat sabe

- As **execuções** do projeto: a mais recente, o que a faz parar (por exemplo, uma verificação que não passou) e quem precisa agir: você, o sistema ou o plano.
- Os **bloqueios**: cada causa registrada, quantas tarefas ela segura e quantas esperam por ela.
- As **perguntas** que aguardam a sua resposta.
- As **execuções anteriores** da mesma spec.
- O **registro completo** de cada spec, que o chat consulta quando a resposta exige mais detalhe.
- Os **documentos principais** do projeto (visão, briefing, stack, fluxo e design), que o chat consulta quando a pergunta é sobre o que eles dizem.

Quando o registro não diz algo, o chat diz que não está registrado e informa em qual registro isso apareceria. Ele não chuta a causa.

## Pesquisa na internet

Para explicar um erro registrado, o chat pode pesquisar na internet **uma vez por pergunta**, e mostra as fontes encontradas ao fim da resposta. A pesquisa não acontece em projetos marcados como confidenciais, nem enquanto o refinamento não respondeu essa pergunta. Só o texto genérico do erro sai do computador; nomes, caminhos e valores do projeto não saem.

## O que o chat não faz

O chat **só responde**. Ele não dá ordens aos agentes nem muda o que está sendo feito: os agentes seguem apenas as specs e o backlog.

## Spec de correção

Se o chat achar que algo em desenvolvimento contraria a spec, ele abre um **rascunho de spec de correção** e mostra o link na resposta. Nada é executado até você revisar e iniciar o refinamento. Uma resposta que pesquisou na internet não abre correção.

## Atalhos e histórico

- O botão **Nova spec** da tela leva direto ao formulário de nova spec do projeto escolhido.
- A conversa de cada projeto fica salva neste computador. **Limpar conversa** apaga as mensagens daquele projeto (as specs de correção já abertas continuam).
