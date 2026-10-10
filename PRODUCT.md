# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

O usuário principal é um desenvolvedor solo que também é o dono do produto: roda o Teams AI na própria máquina (Windows com WSL2 e Docker Desktop), descreve o que quer construir e valida o serviço entregue, delegando todo o resto aos agentes.

## Product Purpose

O Teams AI transforma a descrição de um produto em um serviço testado e publicado, usando um time de agentes de IA executados pela linha de comando do Claude Code.
O usuário faz só duas coisas: descrever o projeto até a descrição ficar sem ambiguidade e validar o resultado depois do deploy.
Sucesso é chegar ao estado `awaiting-validation` com o serviço publicado localmente e os testes de fumaça e ponta a ponta passando, sem o usuário ter escrito código.

## Positioning

Os agentes decidem, propõem e geram; um orquestrador determinístico valida, executa os gates, abre os pull requests, faz o merge e o deploy.
Por isso o produto entrega um serviço testado e no ar, não apenas código sugerido, e nenhum agente executa `git push`, `gh`, `docker` ou `kubectl`.

## Operating Context

- Fluxo: Onboarding (conectar GitHub e Claude), Projetos, Refinamento (Gate 1, perguntas dos papéis Scrum Master e Product Owner), Plano, Execução paralela, Deploy em `docker-local`, Validação.
- A execução é acompanhada ao vivo na página de Run: eventos, tarefas, tokens e custo, com ações de Parar e Retomar.
- Estados de execução que o usuário vê: `running`, `paused:quota`, `paused:auth`, `draining`, `interrupted`, `blocked`, `deadlocked`, `phase-failed`, `done`.
- Problemas encontrados na validação voltam ao Gate 1 como continuação da mesma especificação.
- O usuário trabalha ao lado de um terminal e do GitHub; a interface roda em `http://localhost:8787`.

## Capabilities and Constraints

- Papéis de agente: Scrum Master, Product Owner, Desenvolvedor, Teste, Segurança e DevOps.
- Todo projeto gerado entrega o contrato completo: código, documentação, testes unitários e de ponta a ponta, varreduras de segurança, GitHub Actions, build de imagem e infraestrutura Docker local que sobe.
- Cada etapa de agente roda em sandbox `bubblewrap` com `HOME` vazio; gates e deploys rodam em Docker aninhado sem root.
- A interface só aceita conexões do próprio computador por padrão.
- Depende da assinatura do Claude: quando a janela de uso enche, a execução pausa em `paused:quota` e continua sozinha.
- Idioma: a interface é em português do Brasil hoje; suporte a outros idiomas é um objetivo real para depois, então textos não devem ficar presos ao código.

## Brand Commitments

- Nome: Teams AI.
- Voz: português do Brasil, direto e simples, sem siglas nem abreviações, cada ponto em uma frase com seu contexto.
- O sistema visual vigente está registrado em `design.md` na raiz do repositório.

## Evidence on Hand

- Projetos de referência usados para validar o fluxo de ponta a ponta: `rust-hello-api` e `next-hello-web`.
- Documentação em `README.md` e `docs/superpowers/` (roteiro, especificações, planos, auditoria de segurança).
- Não existem depoimentos, clientes, números de desempenho, preços ou licenciamento comercial; nada disso deve ser inventado.

## Product Principles

1. O usuário descreve e valida; tudo entre essas duas pontas é trabalho dos agentes e do orquestrador.
2. O estado da execução é sempre visível e honesto: o que está rodando, pausado, bloqueado ou falhou, e quanto custou.
3. Segurança por construção: agentes nunca tocam credenciais nem infraestrutura.
4. Entregar serviço funcionando e testado vale mais que entregar código rápido.
5. Familiaridade para quem já é desenvolvedor: nada de affordance inventada para tarefa comum.
