# Plano 120: pedidos em projeto em desenvolvimento

Desenho: `docs/superpowers/specs/2026-11-04-teams-ai-add-specs-design.md`. Branch `feat/refine-add-specs`.

## Status por incremento

| Incremento | Conteúdo | Commit | Status |
|---|---|---|---|
| I1 | ids com `idBase`, primeiro item só sem item iniciado, fechamento docs-repo, espelho do Phase 0, fusão de status | `c92888fb` | Feito |
| I2 | `POST /api/projects/:projectId/requests`, follow-on, fallback sem `specs.json`, uma pendência por projeto, descarte restaura docs | `4ce39716` | Feito |
| I3 | validador do outline do pedido, regra no pacote do PO, seção do pedido sem corte, texto do pedido intocável, `po.md` | `bad1fcc4` | Feito |
| I4 | arquitetura do pedido só acrescenta | `c4241b8e` | Feito |
| I5 | chave do plano ignora seções de pedido, fechamento sem plano de spec iniciada, `outlineDiff` | `58cacb3b` | Feito (sem teste ponta a ponta de contagem de chamadas) |
| I6 | passo `impact` do SM, validado, `IMPACT_DERIVED`, checagem de fechamento | `893dd176` | Feito |
| I7 | pedido roda até pronto, auto-aceite só aditivo | `730aa9bc` | Feito (sem teste ponta a ponta com o fake-claude) |
| I8 | trilha do pedido no snapshot | `635321b9` | Feito |
| I10 | pedido entra no programa que roda: ledger cresce, raiz por item, trava, histórico | `4a5fd02f` | Feito |
| I11 | documentação | — | Em andamento |
| I9 | tela do pedido (frontend) | — | Aguarda aprovação dos wireframes (`design.md` §31) |

## Verificação

- Testes direcionados por incremento, com teste escrito antes da mudança e visto vermelho.
- Suítes completas (raiz e web) só ao final, em segundo plano.
- Rebuild do container local e validação visual só depois do I9.

## Pendências registradas

- Contagem de chamadas de um pedido de ponta a ponta.
- Pipeline do pedido com o fake-claude.
- Teste de rota do pedido na API.
- Validação ao vivo com um projeto de outro formato.
