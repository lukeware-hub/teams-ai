# Relatório — execução ponta a ponta do backlog `r112-biblioteca` (R11.3/R11.4 live check)

Status: **concluído** (o programa terminou; a primeira spec falhou de novo, numa segunda tentativa, e bloqueou as demais, por design). Projeto de teste descartável, 8 specs planejadas, flow em Mermaid. Objetivo: rodar o programa (R11.4) do início ao fim pela tela, corrigindo bugs reais do teams-ai pelo caminho, sem gerar bug novo. Ver "Continuação: mecanismo de retry" abaixo para a segunda rodada.

## Resumo executivo

- O **mecanismo novo (R11.3 + R11.4)** funcionou: congelar uma spec `planned` na sua vez, publicar seus arquivos em main sem sobrescrever, rodar o programa spec a spec, isolar uma falha e bloquear só quem depende dela — tudo se comportou como projetado.
- **3 bugs reais do teams-ai encontrados e corrigidos** nesta sessão, cada um com teste primeiro, suíte inteira verde, commit e push (detalhe abaixo).
- **1 causa-raiz não confirmada** (flake de ambiente): uma tarefa perdeu o binding nativo do `rolldown` e `npm test` falhou só nela, enquanto tarefas irmãs rodando ao mesmo tempo funcionaram. Hipótese registrada, não corrigida sem prova.
- **1 lacuna real e já esperada**: não existe hoje um jeito de "tentar de novo" uma spec cujo run terminou (`verification-failed`) reaproveitando o que já foi mesclado em main. Tentei um retry manual (fora do programa) e ele tentou refazer uma tarefa já entregue. Isso é o "repair loop" que o ROADMAP já separa para R11.4 (continuação)/R11.5, não um bug para corrigir agora.
- **Navegador:** a extensão Claude in Chrome ficou indisponível por boa parte da execução (desconectada, reconexões sem sucesso); o acompanhamento seguiu pela API/journal da run, que é exatamente o que a tela mostraria.

## Linha do tempo

- Esboço e detalhamento da `r112-biblioteca` (8 itens, 8 specs, zero lacunas de cobertura) — já feitos antes desta run, registrados no R11.2.
- **11:55 UTC** — `POST .../start` cria o programa e lança a primeira run, `r112-biblioteca-001-cadastro-livros-r1`. Fase 0: repositório `lukeware-kayron-hub/biblioteca-escolar` criado.
- **11:55–11:58** — Fase 1 (tech-spec, 4 ADRs) e Fase 2 (plano com 10 tarefas, usando o `preplan.json` do detalhamento como contexto pela primeira vez em produção).
- **11:58–14:01 UTC** — Fase 3: 6 tarefas entregues (T0-scaffold, T1, T2, T3, T5, T6), com revisões de código reais corrigidas no caminho (pasta `migrations/` referenciada antes de existir no Dockerfile; tag de imagem dessincronizada do `docker-compose.yml`). **T4 bloqueada** por um erro de ambiente (abaixo). T7-T10 bloqueadas em cascata.
  - Uma pausa de ~90 min por quota de Claude no meio do caminho — comportamento esperado do disjuntor (`server/orchestrator/run.ts:432-451`), retomou sozinha.
- **14:01–14:33 UTC** — Fase 4 (verificação) gera 2 tarefas de correção automática para a lacuna de cobertura (AC-012). Uma delas (**bug #1** abaixo) ficou presa num loop de replan; a outra encontrou um bug real no próprio código gerado (indentação mal tratada ao ler o `docker-compose.yml`) pela revisão de código, e foi corrigida a tempo.
- **14:33 UTC** — `RUN_FINISHED result: verification-failed`. 6 tarefas entregues, 5 bloqueadas, US$ 12,07 só nesta spec.
- **14:34 UTC** — reinicio o container com a correção do bug #1, o programa processa o resultado: item 1 `failed`, itens 2-8 `blocked` em cascata, programa `finished`. Confirma o isolamento de falha do R11.4.
- **14:37–14:58 UTC** — tento duas vezes um retry manual fora do programa (`run` com um `run-id` novo). A 1ª tentativa expôs o **bug #2** (abaixo), corrigido; a 2ª, já sem esse bug, expôs a **lacuna do repair loop** (abaixo) — decido parar de tentar mais retries, porque não é um bug para corrigir sob pressão, é trabalho futuro já mapeado.

## Bugs reais corrigidos (cada um: teste primeiro, suíte inteira verde, commit, push)

1. **Tarefa `devops` sem Bash nenhum trava num loop de replan** — commits `ca5a40a`, `4a3999e`.
   - Sintoma ao vivo: o SM planejou uma tarefa de correção (`T900-fix-2`) com `owner: devops` para escrever um arquivo de teste TypeScript. O papel `devops` não tem nenhuma ferramenta Bash (`ROLE_ALLOW.devops` só tem Edit/Write), então o agente não conseguia rodar `prettier`/`tsc` para corrigir a própria formatação, e a tarefa foi replanejada duas vezes cometendo o mesmo erro.
   - Causa: `planRules` já dizia ao agente "use devops só para Dockerfile, manifests, CI/release workflows e docker-compose", mas nada no código validava isso. Havia dois caminhos que criam/validam tarefas — `validatePlan` (Fase 2/4) e `TaskRunner.replanErrors` (replan dentro da execução) — e nenhum dos dois checava.
   - Correção: nova função `devopsOwnerErrors`/`isInfraPath` (`server/validators/plan.ts`), usada nos dois caminhos. Uma tarefa `devops` cujo `affectedPaths` não é infraestrutura agora é rejeitada e replanejada com `owner: dev` antes de chegar a um agente sem ferramentas para se corrigir.

2. **Um branch de docs idêntico ao main falha ao tentar abrir PR** — commit `a39d9f2`.
   - Sintoma ao vivo: ao tentar uma nova run da mesma spec (retry manual), a Fase 0 falhou com `gh pr create failed: ... No commits between main and docs/...-v1`.
   - Causa: o conteúdo do `spec.json` já estava idêntico ao que tinha sido mesclado por uma run anterior; `commitAll` não tinha nada para commitar, e o branch ficou exatamente em cima do `origin/main` (zero commits à frente). O código sempre tentava abrir um PR, mesmo sem diff nenhum.
   - Correção: `rebase()` agora relata `empty: true` quando o branch fica sem nenhum commit à frente do main depois do rebase; a fila de merge (`MergeQueue`) trata isso como "já aplicado" e pula gates/push/PR/merge, indo direto para a limpeza do worktree.

## Achado registrado, não corrigido (falta confirmação)

- **T4 perdeu o binding nativo do rolldown só nela.** `npm test` falhou na inicialização com "Cannot find native binding" só no worktree de T4, enquanto T2, T3, T5-T8 rodaram com sucesso ao mesmo tempo. Hipótese: `installDeps` (`server/orchestrator/run.ts:252-258`) roda `npm ci` uma vez por tarefa sem serializar entre tarefas concorrentes (`maxParallel` > 1), todas compartilhando o cache npm do container — uma corrida clássica de cache. Não apliquei a correção (serializar `installDeps` por run) porque não tenho prova reproduzível; seria fabricar uma mudança sem confirmação. Fica registrado como candidato de investigação caso o sintoma se repita.

## Lacuna real, já esperada (não é bug)

- **Não existe hoje um "retry" de uma spec cujo run terminou** reaproveitando o que já está em main. Um `run` com `run-id` novo começa um journal do zero e tenta refazer tarefas já entregues (neste caso, T0-scaffold, já mesclado pelo PR #4). O próprio Dev identificou corretamente que não havia nada para mudar, mas o orquestrador exige um diff não vazio para considerar a tarefa feita. Isso é exatamente o "repair loop" (isolar, revisar, corrigir, ajustar e continuar) que o ROADMAP já separa para R11.4 (continuação) / R11.5 — não tentei corrigir sob pressão.

## Resultado final

- **Programa:** `finished`. Item 1 (`cadastro-livros`) `failed`; itens 2-8 `blocked` em cascata (todos dependiam do item 1). Nenhuma spec chegou a `done`.
- **Repositório:** `lukeware-kayron-hub/biblioteca-escolar`, com 6 PRs mesclados (T0-scaffold, T1, T2, T3, T5, T6) antes do bloqueio.
- **Custo:** ~US$ 12,07 na run principal (r1) + ~US$ 1 nas duas tentativas de retry manual (que falharam cedo, antes de qualquer trabalho real) ≈ **US$ 13** nesta parte do teste.
- **Veredito do R11.3/R11.4:** o mecanismo de programa (congelar, publicar, isolar falha, bloquear dependentes) funciona como projetado. O resultado "não concluído" é honesto: uma spec real bloqueou por um motivo de ambiente (não confirmado) mais a falta do repair loop (trabalho futuro), não por falha do código novo desta sessão.
- **Pendências para o humano:**
  1. Apagar os projetos de teste `r112-agenda`, `r112-biblioteca`, `r112-biblioteca-001` e o repositório `lukeware-kayron-hub/biblioteca-escolar` quando terminar de revisar.
  2. Decidir a ordem dos próximos itens: R11.5a (Jev no refinamento), o repair loop (R11.4 continuação / R11.5), ou investigar o flake do rolldown se ele se repetir.

## Continuação: mecanismo de retry (R11.4, sessão seguinte)

O humano pediu para construir, em paralelo, o que faltava: uma spec `failed` poder ser retomada sem refazer o que outra tentativa já mesclou. Escopo travado por decisão: só o mecanismo, sem Jev, sem classificação de causa, sem replanejamento de docs (isso é R11.5/R11.5a).

### Construído (4 peças, cada uma com teste primeiro, suíte inteira verde, commits próprios)

1. **`planned` → `merged` passa a ser uma transição válida** (`server/pipeline/task-state.ts`) — adotar uma tarefa já mesclada por uma run anterior não é um passo de execução, é herdar um fato. Dois testes que usavam essa transição como exemplo de "inválida" foram trocados para outro exemplo (`planned → reviewing`), ainda inválido.
2. **`mergedByPriorRuns`** (`server/orchestrator/workspace.ts`) — lê, de todas as runs anteriores da mesma spec neste projeto (ignorando runs de outro projeto que por acaso reusam o mesmo número, igual a `olderLiveRun` já fazia), o `RUN_FINISHED.merged` de cada uma e junta num só conjunto.
3. **`Run.execute` herda tarefas já mescladas** (`server/orchestrator/run.ts`) — ao virar as tarefas planejadas para `ready`, as que já foram mescladas antes viram `merged` direto; a Fase 4 continua provando tudo pelo JUnit atual do repositório (o código já está lá, de antes).
4. **Ação de retry no programa** (`server/program/controller.ts`, `service.ts`, `registry.ts`, rota `POST /api/refine/:p/:s/program/:itemSpecId/retry`) — `retryItem` limpa um item `failed` de volta para `pending` e desbloqueia o que dependia dele (o próprio `tick()` rebloqueia o que ainda depender de outra causa); nenhuma UI nova.

### Resultado ao vivo (retry de `cadastro-livros`, run `r4`, depois do rebuild do container)

- **O mecanismo funcionou de ponta a ponta:** a run nasceu já sabendo que T0 a T6 estavam mescladas (não refez nenhuma), e executou só T4, T7, T8, T9, T10 — exatamente o que faltava. T4 (que travava com "Cannot find native binding" na tentativa anterior) passou dessa vez sem nenhuma mudança de código: reforça a hipótese já registrada de corrida no `npm ci` concorrente, não resolvida, mas também não reproduzida de novo.
- **Todas as 11 tarefas (T0 a T10) chegaram a `merged`.** Ainda assim a spec terminou `verification-failed`: o AC-012 (persistência depois de `docker compose down`) ficou sem evidência porque o teste que o cobre é de integração, fora do JUnit que a Fase 4 lê; a Fase 4 tentou gerar 2 tarefas de correção automática para isso e as duas foram rejeitadas pelos validadores (um dos achados da sessão anterior: `owner: devops` só mexe em infra) porque o SM reusou ids de tarefas já existentes (`T1`, `T0-scaffold`) em vez de pedir ids novos.
- **Não corrigido:** o gerador de tarefas de correção da Fase 4 reusando ids existentes. É um achado novo, de uma causa diferente do T4, fora do escopo travado desta continuação (não é o mecanismo de retry, que está provado funcionando). Fica registrado para outra rodada.
- **Programa:** `finished` de novo; item 1 `failed`, itens 2-8 `blocked` em cascata. Custo da run `r4`: US$ 8,38.
- **Custo desta continuação:** ~US$ 8,38 (a run ao vivo) + 0 em chamadas de IA para o código (TDD local, sem gastar quota de agente).

### Pendência para o humano

- Mesma lista de antes (apagar os projetos de teste), mais: decidir se vale investigar o gerador de tarefas de correção da Fase 4 (ids reusados) antes ou depois do R11.5a/repair loop — provavelmente o repair loop completo resolve isso por tabela, já que ele classificaria a causa e replanejaria direito.
