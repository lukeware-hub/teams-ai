# Backlog de erros abertos

Este arquivo lista só os erros que ainda estão abertos no teams-ai. Os itens já resolvidos foram retirados em 2026-11-05. O histórico completo continua no Git: o commit anterior à limpeza tem a lista inteira.

Em cada item, o que acontece para quem usa o produto vem primeiro. Depois vem o local no código, e por último a correção ou o estado atual.

## Como ler este backlog

**Backlog** é a lista de erros e de pendências do teams-ai, ou seja, do sistema que usa agentes de IA para construir serviços. Cada item é um erro ou uma pendência. Um item feito com `[x]` já foi resolvido. Um item com `[ ]` ainda está aberto.

**Gravidade de cada erro:**
- **Crítico**: pode expor um segredo (senha ou chave de acesso) ou gerar um custo sem limite.
- **Importante**: faz uma execução perder trabalho, travar ou gastar tentativas à toa.
- **Menor**: erro contido, que não faz perder trabalho.

**Termos usados neste documento:**
- **Execução (run)**: uma tentativa completa de construir uma funcionalidade do projeto, com seus passos.
- **Passo (step)**: um pedido feito a um agente dentro de uma execução.
- **Agente**: uma IA com um papel. Os papéis são PO, SM, Dev, Test, Security, DevOps e Front.
- **Especificação (spec)**: o documento que descreve uma funcionalidade a construir.
- **Verificação automática (gate)**: uma checagem que roda sozinha e aprova ou reprova.
- **Diário (journal)**: o registro de tudo o que aconteceu, em ordem.
- **Orquestrador**: o programa que coordena os agentes e decide o próximo passo.
- **Jev**: um revisor automático de documentos, que usa outro modelo de IA.
- **Refinamento**: a fase em que os documentos do projeto são revisados antes de construir.
- **Publicação (deploy)**: colocar o serviço no ar.
- **Cópia de trabalho (worktree)**: uma cópia separada do código, para um passo trabalhar sem atrapalhar os outros.
- **Branch**: uma linha separada de mudanças no código. A **branch principal (main)** é a versão oficial.
- **Mesclar (merge)**: juntar uma mudança à branch principal.
- **Commit**: um registro salvo de mudanças no código.
- **Pull request (PR)**: um pedido para mesclar uma branch na principal.
- **Cota**: o limite de uso da conta de IA.
- **Orçamento (budget)**: o limite de custo ou de tokens de uma execução.
- **Token**: a unidade que a IA usa para medir texto.
- **Segredo**: senha, token ou chave que não pode vazar.
- **Teste de fumaça (smoke)**: um teste rápido de que o serviço responde.
- **Teste ponta a ponta (e2e)**: um teste do início ao fim, pela interface ou pela API.
- **Cobertura**: a parte do código que os testes percorrem.
- **Serviço**: uma parte do sistema que roda sozinha.
- **Repositório**: uma pasta de código no GitHub.
- **Sandbox**: um ambiente isolado onde o código roda.
- **Dono**: a pessoa que decide o escopo do projeto, ou seja, o usuário.
- **CLI**: o programa de linha de comando do Claude Code, que roda os agentes.
- **Prompt**: o texto com instruções e dados que é enviado à IA.
- **ADR**: registro de uma decisão de arquitetura do projeto, com o motivo.
- **Token de acesso**: uma chave secreta que permite usar um serviço. Não é o mesmo que o token de texto da IA.

## Abertos

Pontos que ainda não foram resolvidos. Cada item diz o que acontece, onde está no código e qual é o estado atual.

### Bugs

- [ ] **[menor] Depois de retomar uma execução, o custo guardado mantém as decisões feitas antes do reinício, mas ainda perde o modelo e a fase de cada passo.** O custo é recalculado em `server/orchestrator/accounting-replay.ts`. As chamadas de decisão já são contadas (commit `6b326ee2`). Ainda aberto: `replayStep` grava `model: 'unknown'` (linha 34) e define `phase` a partir do identificador da tarefa (linha 29), em vez de ler os dois valores do evento `STEP_STARTED` (`server/orchestrator/steps.ts:680-692`). A mesma cópia existe em `server/api/run-routes.ts:348-353`.

- [ ] **[menor] Controles compartilhados menores que 44 px em celulares.** Em uma tela de 390 px, o alternador de tema da barra lateral (32 px), os botões de informação do `InfoTip` (18 px) e os links da trilha de navegação (20 px) ficam abaixo da regra de 44 px para toque. Esses controles aparecem em todas as telas, então as telas de custos também os herdam. Encontrado na auditoria de 2026-11-05. Correção: uma regra de tamanho para toque nos componentes compartilhados, conferida em todas as telas.

  - **Verificar antes de remover:** o código já tem uma regra de toque só para dispositivos de toque (ponteiro grosso) em `web/src/styles.css:443-449`. Medir no Chrome, em 390 px, se a área de toque chega a 44 px. Se passar, este item sai do backlog.

- [ ] **[importante] O custo salvo de uma execução e o diário dela não batem em 16 das 54 execuções concluídas.** Medido em 2026-11-05 na instância em uso. Nas 54 execuções, o total salvo é US$ 45,65 e o total do diário é US$ 46,02. A diferença tem duas causas. Cada uma aparece abaixo, com o seu tamanho:
  - **Escalonamentos do Claude que falharam, corrigidos em `bad97715`.** Uma escalação que falhou foi cobrada e entrou no custo salvo. Mas a tentativa dela no diário não tinha o registro de uso. Por isso o diário perdeu o custo. A correção guarda esse registro de uso na tentativa, nas execuções novas. As execuções gravadas antes da correção ainda não têm esse dado: o diário soma US$ 1,78 a menos em 16 execuções (por exemplo `hello-word--end-to-end-integration-check--run-12`: diário US$ 0,53, salvo US$ 0,64).
  - **Execuções reabertas ou retomadas, sem correção no momento.** `rebuildAccounting` (`server/orchestrator/run.ts:329-352`) refazia o custo só com os eventos de passo. Assim, as decisões do Jev e os escalonamentos do Claude registrados antes do reinício saíam do custo salvo. Por isso o custo salvo ficou abaixo do diário: US$ 2,14 em 8 execuções (por exemplo `hello-word--hello-world-good-night-greeting--run-2`: passos no diário US$ 3,188, mais decisões US$ 0,635, total US$ 3,823; salvo US$ 3,346).

  O painel de custos lê os diários. **Corrigido em `6b326ee2` para toda retomada a partir de agora:** a recontagem (`server/orchestrator/accounting-replay.ts`) agora conta as chamadas de decisão cobradas (Jev, local e Claude) registradas no diário. Em 2026-11-05, os totais salvos das 6 execuções retomadas que podiam ser corrigidas com exatidão foram atualizados para o diário (US$ 1,96 a mais; cópias de segurança na pasta de dados das execuções, `runs-backup-totals-2026-11-05`). As outras 11 execuções têm um escalonamento do Claude que falhou sem custo registrado. Por isso o total salvo delas guarda um custo real que o diário não consegue reproduzir. Elas ficam como estão, e o dono decide se aceita esses valores.

### Decisão do dono

Ação do dono, fora do código: o teste ponta a ponta (e2e) do `privacy-engine` precisa de `PLATFORM_ADMIN_TOKEN` (ADR-030: pelo menos 32 caracteres, com o mesmo valor do `identity-service`). Esse token precisa estar nos segredos do projeto e declarado em `externalDependencies` da especificação. Sem a declaração, o gate (a verificação automática) não recebe o segredo.

### Vindos da revisão de habilidades de linguagem (2026-10-30)

Encontrados ao avaliar se vale instalar as habilidades de linguagem da migração de agentes (2026-10-30). Cada item foi conferido no código citado ou nos dados da execução. Nenhum foi resolvido ainda. O estudo completo está em `docs/superpowers/spikes/2026-10-30-language-skills.md`.

- [ ] **[menor] Um passo retomado pode registrar o custo da sessão inteira como se fosse só dele.** Quando o total acumulado do CLI cai, `server/runner/step.ts:308-312` usa o número informado como custo do próprio passo. Nas execuções revisadas, esse número era o total da sessão em 132 de 132 casos conferidos. A conferência usou os registros de custo do CLI nas transcrições. Por isso o gasto registrado ficou cerca de 2,4 vezes o gasto corrigido. Correção: calcular o custo próprio de um passo com reinício do total usando esses registros, e testar contra eles. A parte de uso desse mesmo registro foi corrigida no commit `731d6375`. Este caso de reinício do total não foi.

  Situação: aberto. Conferido no código: uma tarefa roda uma sessão por vez (`sessionFor` mantém uma sessão por Dev). Por isso um passo não consegue subtrair o total de outra sessão. E o arquivo de totais por tarefa não é a causa desses reinícios. O que sobra é uma queda do total acumulado do CLI dentro de uma mesma sessão. Próximo passo: comparar a transcrição de um passo marcado com o total informado, e verificar se a queda acontece depois de uma compactação automática (`compact_boundary` na transcrição).

  Atualização de 2026-11-05: `step.ts` agora registra a diferença de custo quando só o tempo de API voltou (correção preventiva). As 45 execuções do volume local `teams-ai-data` (projetos `hello-word` e `live-*`) não têm nenhum passo com esse reinício. Por isso a causa ainda não foi confirmada. As execuções revisadas provavelmente vieram do projeto `kayron-hub`, que não está nesta máquina. Para confirmar, restaure esse volume e rode `npm run run:report <run directory>`. A coluna `sessionResets` conta esses passos.

### Vindos das regras globais dos agentes (2026-10-30)

- [ ] **[menor] Nomes de arquivos em português no teams-ai.** `scripts/guia/atualizar-grafo.sh` e os arquivos de `docs/guia/` têm nomes em português. Renomear só junto com a reconstrução do grafo do guia (`task guia:grafo`).

- [ ] **[menor] O título `## Decisões` ainda é gravado em português.** `server/refine/decisions.ts` grava esse título. Os leitores já aceitam `Decisões` e `Decisions`. Para mudar a gravação, antes é preciso ter a mesma leitura compatível. Isso mexe nos documentos do dono; a decisão é dele.

- [ ] **[importante] A falha `already exists` na cópia de trabalho se repete.** O comando `git worktree add` falha com `already exists` em 51 registros de 18 execuções (por exemplo, execução 14, passos 196 a 205). A tarefa tenta de novo três vezes. Depois, o replanejamento repete o mesmo passo. A causa não é conhecida. O `ui.log` mostra `reconcile: redo WORKTREE_CREATE` em cada início. Falta encontrar a cópia de trabalho que sobrou, e entender por que a conciliação não a remove.

  Atualização de 2026-11-05: `createWorktreeUnlocked` agora limpa a pasta e tenta criar de novo uma vez quando aparece `already exists` (correção preventiva). As 45 execuções locais não têm essa falha. Por isso a causa ainda não foi confirmada. Os registros das 18 execuções vieram de um volume que não está nesta máquina, provavelmente do projeto `kayron-hub`. Para confirmar, restaure esse volume e rode `npm run run:report <run directory>`. A coluna `worktreeExists` conta essas falhas.

- [ ] **[menor] O feedback nunca entra no orçamento do pacote do Dev.** `server/knowledge/context-pack.ts:79` coloca cada texto de feedback inteiro no prompt do Dev. Uma única lista de escopo chegou a 213.606 caracteres. Tentativa revertida: limitar o feedback a 40.000 caracteres quebrou a recusa de pacote grande (`server/refine/fit-pack.ts`), porque os documentos de refinamento também vão no campo `feedback`. Um documento grande seria cortado sem aviso. Falta decisão do dono: manter o feedback inteiro, recusar acima de um limite com mensagem clara, ou resumir com um passo de agente.

- [ ] **[menor] O chat só confere as consultas de busca pelas regras e pelo registro.** Uma consulta que cita o projeto é registrada, mas não é recusada. Falta um filtro no código. Não feito: a consulta sai para a web antes de qualquer filtro, então cortar as fontes não corrige o vazamento. Precisa de uma restrição na ferramenta de busca do CLI.

- [ ] **[menor] A resposta de confidencialidade do dono fica só no diário do refinamento.** `project.json` mantém o valor padrão. A verificação de busca do chat lê o diário. Por isso um projeto novo precisa responder antes de poder ser pesquisado pelo chat. Não feito: não há um jeito seguro de gravar `docs/project.json` pelo servidor. Gravar ali é um commit no repositório do projeto. A verificação do chat já lê o diário.

## A fazer: branches locais removidos (2026-11-05)

Os branches locais `feat/cost-dashboard`, `fix/deploy-fixture-network` e `fix/dev-rules-upfront` foram apagados em 2026-11-05. O branch remoto de cada um já tinha sido apagado no GitHub. Os commits continuam acessíveis pelo hash enquanto o Git guardar o histórico local. Para recuperar um deles, use `git branch <nome> <hash>`. As pontas eram: `feat/cost-dashboard` em `5c6ea508`, `fix/deploy-fixture-network` em `27d337fb` e `fix/dev-rules-upfront` em `32eca016`.

### Painel de custos (`feat/cost-dashboard`)

- [ ] **[menor] Papel e modelo do escalonamento, quando a execução é retomada.** Conferido: o orçamento não é afetado. O orçamento por tarefa e o total usam o `taskId` e a soma geral. E o escalonamento grava `taskId: null` nos dois caminhos. A diferença ao retomar está só no papel (`system1` no replay, e o papel do escalonamento ao vivo) e no modelo (`claude` no replay, e o modelo real ao vivo). Isso afeta só o relatório por papel de uma execução retomada. Para corrigir, é preciso gravar o papel no registro de decisão. Isso muda o formato do diário (journal). Fica aberto.

- [ ] **[menor] Documentação do painel.** `docs/superpowers/FEATURES.md` e a seção 34 do design do branch estão desatualizados. Reescrever na main, a partir do estado atual do código.
