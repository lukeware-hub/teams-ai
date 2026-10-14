# Execução: acompanhar o desenvolvimento

Perguntas que este texto responde: como acompanhar a execução, como parar, como retomar, o que significa pausada por cota, o que é aguardando login, o que é bloqueada, o que é reprocessar, onde vejo o custo, como iniciar a execução de uma spec.

## Como a execução começa

Depois de **Iniciar análise** no refinamento, o sistema abre a tela de **Execução**. Também é possível começar uma spec pronta pela página do projeto, com o botão **Iniciar execução** na linha da spec.

## O que a tela mostra

- As **fases** do trabalho e a fase atual: 0 Preparação do repositório, 1 Especificação técnica, 2 Plano, 3 Implementação, 4 Verificação, 5 Deploy (publicar o serviço no seu computador) e 6 Relatório.
- As **tarefas** de cada fase, com a situação de cada uma: aguardando a vez, pronta, sendo desenvolvida, em testes, em revisão, concluída ou bloqueada.
- O **custo estimado** e os **tokens** usados.
- Os eventos ao vivo.

## Parar e Retomar

- **Parar execução**: a etapa em andamento termina e a execução encerra. Ela passa por "finalizando" antes.
- **Retomar**: continua uma execução parada, interrompida ou que esperava login. Use depois de entrar de novo no Claude.

## Quando algo não anda

- **Pausada por cota**: o limite de uso do Claude acabou. Nada a fazer: a execução continua sozinha quando o limite renovar.
- **Aguardando login**: a sessão do Claude expirou. Entre de novo (veja "primeiros-passos") e clique em **Retomar**.
- **Interrompida**: o processo parou antes do fim. Clique em **Retomar**.
- **Bloqueada**: uma tarefa não pôde ser concluída. Abra a execução para ler o motivo. Se a causa estiver resolvida, use **Reprocessar** para recomeçar a spec.
- **Travada**: as tarefas que sobraram dependem umas das outras e nenhuma pode começar.
- **Fase falhou**, **Verificação falhou**, **Deploy falhou**: a execução mostra qual etapa falhou e por quê.

Quando termina bem, a execução vira **Aguardando validação**: o serviço está publicado no seu computador e os testes passaram. Aí é com você (veja "validacao").
