# Pedidos em projeto em desenvolvimento

Data: 2026-11-04. Plano de execução: `docs/superpowers/plans/2026-11-04-teams-ai-120-add-specs-running-project.md`.

## Problema

Hoje uma spec nova num projeto que já está em desenvolvimento entra por "Nova spec": uma spec única, refinada à parte, fora do programa em andamento. Não há análise de impacto, não há replanejamento e não há coordenação com o programa que já roda.

## Decisão

Um pedido é um **backlog de acompanhamento** (follow-on): o mesmo motor de refinamento do backlog, semeado com o texto do dono. Nada de um segundo mecanismo.

1. O dono escreve o pedido em texto livre, no botão "Nova spec", que agora pede só a descrição.
2. O texto vira o briefing do rascunho `<projeto>-pedido-<n>`. Ao ativar o backlog, o texto é anexado ao briefing do projeto sob `## Nova demanda (<id do rascunho>)`, com os títulos rebaixados. Essa seção é a âncora de rastreio.
3. Os ids das specs seguem o esquema da main (`idBase`), para que um pedido não duplique specs existentes.
4. A arquitetura decidida só pode ganhar repositórios e integrações; o estilo fica.
5. A saída do PO mantém todo item do backlog anterior e cita a seção do pedido em cada item novo.
6. O SM mede o impacto: o que o pedido toca, o que conflita, o que repete, do que depende e os riscos. O impacto é validado (referências existentes, sem ciclo, sem ajuste direto de spec iniciada) e pedido de novo uma vez quando quebra regra.
7. A chave do plano ignora as seções de pedido: planos de itens não tocados são reaproveitados.
8. O pedido roda sozinho até "pronto". Aceita sozinho só acréscimos em project.md, flow.md e briefing.md; remoção, reescrita, mudança de stack ou de design e aprovação de ajuste esperam o dono.
9. "Iniciar" é sempre o clique do dono. Quando há um programa rodando, o pedido entra nele: os itens novos entram na fila, os pendentes recebem a nova ordem e as dependências, o que começou ou foi entregue fica como está, e a mudança fica no histórico do programa.

## Limites conhecidos

- Projeto cuja main não tem `specs.json` (nunca teve backlog) recebe o pedido como uma spec única, sem análise de impacto nem replanejamento.
- Com alguma spec iniciada não há mapa de conflitos do SM (`detail-cycle`): os itens novos rodam um de cada vez.
- Um pedido por projeto de cada vez: o segundo espera o primeiro iniciar.
- "Pedido já coberto por um item" depende do impacto; o validador não prova isso sozinho.
- Colisão de chave com uma spec de main já retirada não é checada.
- A tela do pedido (fase 9) depende da aprovação dos wireframes (`design.md` §31).

## Rastreio

Pedido (seção de `briefing.md`) → `derivedFrom.sources` de cada spec nova ou alterada → plano e tarefas da spec. O evento `REFINE_REQUEST_RECEIVED` guarda o pedido e `IMPACT_DERIVED` o impacto medido.
