# Validar a entrega: aceitar ou relatar um problema

Perguntas que este texto responde: como validar a entrega, como validar, o que é aguardando validação, como concluir uma spec, como relatar um problema, como corrigir algo que já foi entregue, o que é Continuar spec, o que é Reiniciar.

Quando a execução termina, a spec fica **Aguardando validação**. O serviço já está no ar no seu computador. Na página do projeto, clique em **Validar** na linha da spec.

## A tela de validação

Ela mostra o resumo da entrega, o custo, as evidências por critério (o que foi testado), a segurança, as suposições dos agentes, as tarefas bloqueadas e um roteiro de teste manual. Use o roteiro para experimentar o serviço você mesmo.

## Sua decisão

- **Concluir especificação**: aceita a entrega. A spec passa a **concluída** e fica somente leitura.
- **Relatar problema**: escreva o que está errado em **Descrição do problema** e clique. O refinamento da mesma spec reabre com o seu relato e os agentes corrigem.

## Cobertura dos documentos

Depois da execução, a tela mostra os trechos dos documentos do projeto que ficaram de fora da entrega. Cada trecho aberto traz:

- **O que falta**, em linguagem simples.
- **O motivo** registrado pela execução, por exemplo uma tarefa bloqueada ou um teste que falhou.
- **Preencher o relato**: copia o trecho para **Descrição do problema**. Depois clique em **Relatar problema**.
- **Aceitar como fora de escopo**: registra a sua decisão com um motivo. A entrega não muda.

Se o motivo for uma falha da execução, use **Reprocessar** na página da execução.

## Depois

- Uma spec **aguardando validação** tem na página do projeto os botões **Continuar spec** (reabre para um novo refinamento) e **Reiniciar** (descarta a sessão de refinamento atual e recomeça do zero, com confirmação).
- Uma spec **concluída** não muda mais: a próxima entrega começa em **Nova spec** (veja "criar-spec").
