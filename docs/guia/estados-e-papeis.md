# Estados e papéis: o que cada palavra significa

Perguntas que este texto responde: o que significa cada status, o que é planejada, o que é em refinamento, quem são os agentes, o que faz o Produto, o que faz o Técnico, quais papéis existem, o que é o orquestrador.

## Estados de uma spec

- **Em refinamento**: ainda está sendo escrita e avaliada.
- **Planejada**: faz parte de um backlog e espera a vez.
- **Pronta para executar**: a lista de verificação foi atendida; falta iniciar.
- **Em execução**: os agentes estão trabalhando.
- **Pausada por cota** ou **aguardando login**: veja "execucao".
- **Aguardando validação**: entregue; falta você validar.
- **Concluída**: aceita por você; somente leitura.
- **Retirada**: saiu do backlog e nunca será executada.

## Estados de um refinamento em andamento

**Em edição** (descrição sendo escrita), **em avaliação** (os agentes revisam), **aguardando respostas** (há perguntas ou sugestões para você), **pronto para iniciar** (tudo atendido), **com erro**.

## Estados de uma tarefa

Aguardando a vez, pronta para começar, sendo desenvolvida, em testes, em revisão, sendo atualizada com o código mais novo, sendo incorporada ao código principal, concluída, bloqueada ou substituída por outra.

## Quem faz o quê

- **Produto** (Product Owner): confere objetivos, critérios de aceite e fluxo de negócio e faz perguntas a você.
- **Técnico** (Scrum Master): confere tecnologias, divide o trabalho em tarefas e acompanha a viabilidade.
- **Desenvolvimento, Visual (front), Testes, Segurança, Infraestrutura e Ambiente**: executam, testam, revisam e publicam. Cada um só faz o seu papel, e nenhum agente mexe nas suas credenciais.
- **Orquestrador**: não é um agente. É o programa que valida o trabalho, roda as verificações, abre os pull requests, faz a junção do código e publica. Ele só segue as specs e o backlog.
