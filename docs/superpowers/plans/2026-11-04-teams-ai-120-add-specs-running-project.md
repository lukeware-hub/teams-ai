# Plano 120: pedidos em projeto em desenvolvimento

Desenho: `docs/superpowers/specs/2026-11-04-teams-ai-add-specs-design.md`. Branch `feat/refine-add-specs`.

## Status por incremento

| Incremento | Conteúdo | Commit | Status |
|---|---|---|---|
| I1 | ids com `idBase`, primeiro item só sem item iniciado, fechamento docs-repo, espelho do Phase 0, status mais avançado, congelamento no store | `c92888fb`, `722a65ac` | Feito no código; faltam testes nomeados (`backlog-derive`, `store-two-drafts`, `docs-closing`) e o tipo `idBase` no web |
| I2 | `POST /api/projects/:projectId/requests` com `mode`, seção "Pedido pedido-N", id com até 40 caracteres, texto sem controles, títulos rebaixados, diário com cabeçalho e `idBase`, fallback `single`, descarte restaura docs | `4ce39716`, `6820c95e` | Feito no código; faltam testes de ordem, reabertura, mutex e descarte com documento alterado |
| I3 | validador do outline (item alterado cita o pedido), pacotes digeridos mantêm o pedido inteiro, revisões de frente não reescrevem o pedido, `po.md` | `bad1fcc4`, `d24c785e` | Parcial: faltam rejeição de movimento que toca o pedido e colisão de chave com alias retirado |
| I4 | arquitetura do pedido só acrescenta | `c4241b8e` | Feito no código; faltam testes nomeados (validação aditiva, gating, laço de duas tentativas, fechamento) |
| I5 | chave do plano ignora seções de pedido, fechamento sem plano de spec iniciada, `outlineDiff` | `58cacb3b` | Parcial: os itens não tocados ainda são replanejados (faltam cópia do main e o teste de contagem de chamadas) |
| I6 | passo `impact` do SM: `requestId` no contrato, referências validadas, refeito quando quebra regra, obsoleto detectado, somente leitura, rótulo no banner, `IMPACT_DERIVED` | `893dd176`, `c6ebdf10` | Feito; o perfil de modelo é o mesmo do passo de conflitos (sem entrada própria) |
| I7 | pedido roda até pronto (`runExtension`), auto-aceite só aditivo marcado no diário, cartão lista os acréscimos | `730aa9bc`, `c463562e`, `666620db` | Parcial: falta o teste ponta a ponta com fake-claude e o teste de dado confidencial |
| I8 | trilha do pedido no snapshot com veredito por spec; rota de pedido responde o modo | `635321b9`, `fb319531`, `fafe060b` | Parcial: faltam contagem de tarefas por spec (o estado não guarda) e teste de snapshot da sessão |
| I9 | tela do pedido e formulário do hub conforme os wireframes aprovados | `0af601a5`, `1ea4e5d9`, `666620db` | Feito no código; faltam critique, audit e polish formais, o passo do assistente em `wizard.ts` e o `finalScreen` |
| I10 | pedido entra no programa que roda: ledger cresce, trava inclui o tick, histórico com `pedido-N` e rascunho | `4a5fd02f`, `2e888959` | Parcial: item já iniciado no main não é restaurado da base; falta teste do caminho de início e de fechamento |
| I11 | documentação e grafo do guia | `f331ddf2`, `2b304c9e` | Feito |

## Verificação

- Testes direcionados por incremento, com teste escrito antes da mudança e visto vermelho.
- Suítes completas (raiz e web) só ao final, em segundo plano.
- Rebuild do container local e validação visual só depois do I9.

## Pendências registradas

- Contagem de chamadas de um pedido de ponta a ponta.
- Pipeline do pedido com o fake-claude.
- Teste de rota do pedido na API.
- Validação ao vivo com um projeto de outro formato.
