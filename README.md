# Teams AI

[![CI](https://github.com/diego-dm-morais/teams-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/diego-dm-morais/teams-ai/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

O Teams AI transforma a descrição de um produto em um serviço testado e publicado. Quem faz o trabalho é um time de agentes
de IA (Scrum Master, Product Owner, Desenvolvedor, Teste, Segurança e DevOps), executados pela CLI do
[Claude Code](https://docs.claude.com/en/docs/claude-code).

Você faz só duas coisas:

1. **Descrever o projeto** na interface web. Os agentes perguntam até a descrição ficar sem ambiguidade.
2. **Validar o resultado** depois do deploy e, se achar problemas, reportá-los na mesma especificação.

O resto (especificação técnica, plano de tarefas, código, testes, revisão, commits, pull requests, merge e deploy) é feito
pelos agentes, sob controle de um orquestrador determinístico.

> **Regra central:** os agentes decidem, propõem e geram. O orquestrador valida, executa e muda o estado.
> Um agente nunca roda `git push`, `gh`, `docker` ou `kubectl`; quem roda é o orquestrador.

## Comece em 5 minutos (Windows)

1. Em um PowerShell **como Administrador**, na pasta do projeto, instale os pré-requisitos (WSL2, Git, Docker Desktop e Task).
   O script pula o que já estiver instalado:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
   ```

2. Reinicie se o script pedir, abra o Docker Desktop (espere "Engine running") e, em um terminal novo, na pasta do projeto:

   ```bash
   task start
   ```

   O comando confere os pré-requisitos (se algo faltar, diz como corrigir), sobe a plataforma, espera ficar saudável e abre
   <http://localhost:8787>. O primeiro build leva alguns minutos.

3. Na UI, siga o **Onboarding** para conectar GitHub e Claude. Detalhes em [Primeiro acesso](#primeiro-acesso-conectar-suas-contas).

Algo não subiu? Rode `task doctor`. Os passos manuais completos estão em [Instalação no Windows](#instalação-no-windows).

## Sumário

- [Comece em 5 minutos (Windows)](#comece-em-5-minutos-windows)
- [Como funciona](#como-funciona)
- [O que você precisa](#o-que-você-precisa)
- [Instalação no Windows](#instalação-no-windows)
  - [Caminho A: Docker Desktop (recomendado)](#caminho-a-docker-desktop-recomendado)
  - [Caminho B: WSL2 a partir do código (desenvolvimento)](#caminho-b-wsl2-a-partir-do-código-desenvolvimento)
- [Primeiro acesso: conectar suas contas](#primeiro-acesso-conectar-suas-contas)
- [Usando o Teams AI](#usando-o-teams-ai)
- [Configuração](#configuração)
- [Referência da CLI](#referência-da-cli)
- [Comandos do Task](#comandos-do-task)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Solução de problemas](#solução-de-problemas)
- [Segurança](#segurança)
- [Mais documentação](#mais-documentação)
- [Licença](#licença)

## Como funciona

```text
Você: descreve o projeto (UI)
        |
        v
 Gate 1 - Refinamento    Agentes SM e PO fazem perguntas até a documentação ficar clara
        |
        v
 Plano                   O SM monta o grafo de tarefas; o Dev escreve a especificação técnica
        |
        v
 Execução (paralela)     Agentes Dev / Test / Security / DevOps trabalham em git worktrees;
                         o orquestrador roda lint, testes e gates, abre PRs e faz o merge
        |
        v
 Deploy                  Alvo `docker-local` + testes de smoke e e2e
        |
        v
Você: valida (UI)        Problemas voltam ao Gate 1 como continuação da mesma especificação
```

Principais peças:

| Peça | O que faz |
| --- | --- |
| Orquestrador (`server/orchestrator`) | Máquina de estados baseada em eventos. Um processo `claude -p` por etapa de agente. O journal só acrescenta registros, então nada se perde se o processo cair. |
| Agentes (`server/agents`) | Papéis `sm`, `po`, `dev`, `front`, `test`, `sec` e `devops`, cada um com permissões restritas. |
| Plano de execução (`server/exec`, `server/deploy`) | Roda gates (testes, scans) e deploys dentro de um Docker aninhado e sem root, nunca no Docker do seu computador. |
| Orçamento e cota (`server/budget`) | Controla tokens e custo; pausa a execução quando a janela da assinatura do Claude está quase no fim e retoma sozinho. |
| Camada de decisão (`server/decide`) | Opcional. Responde decisões simples localmente antes de chamar o Claude. |
| Conhecimento (`server/knowledge`) | Busca de contexto no projeto, com apoio opcional do `graphify`. |
| API + UI web (`server/api`, `web`) | Onboarding, projetos, chat de refinamento, acompanhamento ao vivo e validação. Servida na porta `8787`. |
| Supervisor (`server/supervisor`) | Retoma execuções interrompidas até terminarem. |

## O que você precisa

- Um PC com Windows 10 (22H2) ou Windows 11, com virtualização ativada na BIOS/UEFI. Recomendado: 16 GB de RAM e 30 GB livres em disco.
- Uma **assinatura do Claude** que funcione com o Claude Code (Pro, Max ou Team). O projeto não usa `ANTHROPIC_API_KEY`.
- Uma **conta no GitHub** (usuário ou organização) onde os projetos gerados serão criados, e um token de acesso pessoal dela.
- Uma **chave da OpenRouter**: o Jev, que confere a consistência dos documentos e decide pontos do refinamento, depende dela. Sem a chave, o refinamento não inicia.

Por que não rodar direto no Windows? O orquestrador é um programa Linux: a UI usa o `script` do util-linux, as etapas dos
agentes usam sandboxes `bubblewrap` e os gates rodam em contêineres Linux. No Windows, ele roda dentro do Docker Desktop
(Caminho A) ou do WSL2 (Caminho B).

## Instalação no Windows

### Passo 0: ativar o WSL2 (vale para os dois caminhos)

Abra o **PowerShell como Administrador**:

```powershell
wsl --install -d Ubuntu
```

Reinicie quando for pedido, abra o "Ubuntu" no menu Iniciar uma vez e crie seu usuário e senha Linux.
Confirme que a versão é WSL 2:

```powershell
wsl -l -v      # o Ubuntu deve mostrar VERSION 2
```

### Passo 1: instalar Git e Docker Desktop

Com o `winget` (PowerShell):

```powershell
winget install --id Git.Git -e
winget install --id Docker.DockerDesktop -e
winget install --id Task.Task -e
```

O [Task](https://taskfile.dev) é o executor de comandos do projeto (`Taskfile.yml`). Depois, abra um novo terminal e rode
`task --list` dentro do repositório para ver todos os comandos. No Ubuntu (Caminho B), instale-o também:
`sudo snap install task --classic` (ou veja <https://taskfile.dev/installation>).

Abra o Docker Desktop e espere aparecer "Engine running". Em **Settings**:

- **General**: ative "Use the WSL 2 based engine".
- **Resources > WSL Integration**: ative a sua distribuição Ubuntu (necessário só no Caminho B).

Confirme:

```powershell
docker --version
docker compose version
```

### Caminho A: Docker Desktop (recomendado)

Sobe a plataforma inteira (orquestrador, API, UI web e um Docker aninhado sem root) com um comando.

1. Clone o repositório. Para ter mais desempenho de arquivos e menos problemas de fim de linha, faça isso de dentro do Ubuntu:

   ```powershell
   wsl -d Ubuntu
   ```

   ```bash
   git clone https://github.com/diego-dm-morais/teams-ai.git
   cd teams-ai
   ```

   (Clonar pelo Windows também funciona; o repositório tem um `.gitattributes`.)

2. Crie o arquivo de ambiente (o `task up` também faz isso sozinho se o `.env` não existir):

   ```bash
   task setup
   ```

   Edite o `.env` com o que já tiver. Todas as chaves são opcionais agora; dá para configurá-las depois na UI:

   ```dotenv
   # GITHUB_TOKEN=ghp_xxx                 # token que cria repositórios e PRs na sua conta/organização
   # CLAUDE_CODE_OAUTH_TOKEN=             # token longo gerado por `claude setup-token` (dispensa o login no navegador)
   # TEAMS_AI_UI_TOKEN=                   # necessário só se você publicar a UI na sua rede local
   ```

3. Construa e inicie:

   ```bash
   task up        # equivale a: docker compose up -d --build
   ```

   O primeiro build leva alguns minutos (instala as dependências Node, a CLI do Claude Code e compila a UI web).

4. Espere os dois serviços ficarem saudáveis e abra a UI:

   ```bash
   task ps
   ```

   Acesse <http://localhost:8787> no navegador.

5. Siga para [Primeiro acesso](#primeiro-acesso-conectar-suas-contas).

Comandos úteis:

```bash
task logs       # acompanha os logs do orquestrador
task restart    # reinicia o orquestrador
task down       # para tudo (mantém seus dados)
task shell      # abre um shell dentro do contêiner
task reset      # para e APAGA todos os dados, logins e workspaces (pede confirmação)
```

Onde ficam seus dados (volumes Docker nomeados): `teams-ai-data` (configuração, workspaces, execuções e segredos),
`teams-ai-claude` (login do Claude), `teams-ai-gh` (login do GitHub CLI) e `dind-data` (imagens do Docker aninhado).

Para compartilhar a UI na rede local (opcional): defina `TEAMS_AI_UI_BIND=0.0.0.0` **e** um `TEAMS_AI_UI_TOKEN` forte no `.env`,
e adicione o hostname que você usa em `TEAMS_AI_ALLOWED_HOSTS` (a API rejeita `Host` desconhecido). Nunca exponha sem token.

> Observação: o `dind` sem root precisa de `/dev/net/tun` e de seccomp/AppArmor mais flexíveis. Ele está implementado e
> coberto por testes unitários; a verificação ponta a ponta em cada máquina ainda consta como pendente em
> `docs/superpowers/ROADMAP.md`. Se o `dind` não ficar saudável no seu computador, veja [Solução de problemas](#solução-de-problemas).

### Caminho B: WSL2 a partir do código (desenvolvimento)

Use se quiser alterar o código, rodar os testes ou usar a CLI diretamente. Tudo abaixo roda **dentro do Ubuntu**
(`wsl -d Ubuntu`). Mantenha o repositório no sistema de arquivos Linux (`~/teams-ai`), não em `/mnt/c`.

1. Clone:

   ```bash
   git clone https://github.com/diego-dm-morais/teams-ai.git ~/teams-ai
   cd ~/teams-ai
   ```

2. Instale as ferramentas com o script fornecido (pode ser rodado várias vezes):

   ```bash
   task wsl:setup     # equivale a: bash scripts/wsl/setup-ubuntu.sh
   ```

   Ele instala, nesta ordem:

   | Ferramenta | Para quê | Como o script instala |
   | --- | --- | --- |
   | Pacotes apt: `curl git unzip build-essential cmake python3 pipx bubblewrap socat` | ferramentas básicas de build; `bubblewrap` e `socat` são dependências do sandbox do Claude Code | `apt-get` |
   | Node.js 22 | ambiente de execução (`>=22.13`) | `nvm` (também registrado em `~/.profile`) |
   | CLI do Claude Code | executa os agentes | `npm install -g @anthropic-ai/claude-code` |
   | GitHub CLI `gh` | PRs, merges e criação de repositórios (rodado pelo orquestrador) | repositório apt do GitHub |
   | `gitleaks`, `osv-scanner` | scans de segredos e dependências usados como gates | binários das releases do GitHub |
   | `graphify` | grafo de conhecimento opcional | `pipx install graphifyy` |
   | Docker | gates e deploys | **não é instalado**: vem da integração WSL do Docker Desktop (Passo 1) |

   Instale também o `script` do `util-linux` se faltar (`sudo apt install bsdutils`); a UI precisa dele para o terminal de login.

3. Verifique as ferramentas (imprime um relatório JSON; todas as que você precisa devem ter `"present":true`):

   ```bash
   task wsl:check
   ```

4. Instale as dependências do projeto e compile a UI web:

   ```bash
   task install
   task web:build
   ```

5. Rode as verificações (opcional, mas recomendado; é o que a CI executa):

   ```bash
   task check
   ```

6. Inicie a UI:

   ```bash
   task ui
   ```

   Acesse <http://localhost:8787> pelo Windows (o WSL2 encaminha o localhost). Para desenvolver a UI com recarga ao vivo, use
   `task web:dev` (servidor Vite com `/api` redirecionada).

7. Crie sua configuração (opcional; os valores padrão funcionam):

   ```bash
   mkdir -p ~/.teams-ai
   cp config.example.json ~/.teams-ai/config.json
   ```

   Edite `github.owner`. Na instalação local (sem compose), **remova o bloco `docker.bindRewrite`** do arquivo copiado; ele
   serve só para a implantação em contêiner. Veja [Configuração](#configuração).

## Primeiro acesso: conectar suas contas

Acesse <http://localhost:8787>. A página **Onboarding** lista o que precisa ficar verde antes de você rodar qualquer coisa.
Cada item é recalculado ao vivo.

| Item | O que fazer |
| --- | --- |
| **Claude** | Clique no botão de login e siga o fluxo no navegador, no terminal embutido (`claude auth login`). Ou, por terminal: `task login:claude`. Alternativa: rode `claude setup-token` em qualquer lugar, coloque o resultado em `CLAUDE_CODE_OAUTH_TOKEN` no `.env` e rode `docker compose up -d`. |
| **GitHub owner** | Informe o usuário ou a organização do GitHub que será dono dos repositórios gerados. |
| **Login do GitHub (`gh`)** | Faça login do `gh` pelo terminal embutido (`gh auth login`) ou rode `task login:gh`. |
| **Token do GitHub** | Cole um token de acesso pessoal (clássico: `repo` e `workflow`; ou fine-grained com permissão para criar repositórios e acessar conteúdo, pull requests e workflows). Fica guardado em `~/.teams-ai/secrets` e nunca é exibido de novo. |
| **Chave da OpenRouter** | Cole a chave de API do OpenRouter. O Jev confere os documentos, classifica critérios e perguntas em cada avaliação, e o refinamento não inicia sem ele. |

Quando todos os itens estiverem verdes, está tudo pronto.

## Usando o Teams AI

1. **Adicione um projeto** na página Projetos (nome, repositório no GitHub e workspace local).
2. **Refine** (Gate 1): escreva o que o projeto é, o que faz, quem o usa e quais são os objetivos. Tarefas e stack são opcionais.
   Responda às perguntas dos agentes SM e PO até eles aceitarem a documentação.
3. **Inicie a execução.** Acompanhe ao vivo na página Run (eventos, tarefas, tokens e custo). Você pode **Parar** (a etapa atual
   termina antes) e **Retomar** depois. Se a janela da assinatura do Claude estiver quase cheia, a execução mostra
   `paused:quota` e continua sozinha quando a janela reinicia.
4. **Valide.** Quando a execução chega a `awaiting-validation`, o serviço já foi publicado (`docker-local`) e os testes de
   smoke e e2e passaram. Experimente e então aceite ou reporte problemas; eles voltam ao Gate 1 como continuação da mesma especificação.

Status de execução que você verá: `running`, `paused:quota`, `paused:auth`, `draining`, `interrupted`, `blocked`, `deadlocked`,
`phase-failed`, `done`. `paused:auth` significa que o login do Claude expirou: entre de novo e depois clique em Retomar.

Todo projeto gerado deve entregar o contrato completo: código, documentação, testes unitários e e2e, scans de segurança,
GitHub Actions, build de imagem e uma infraestrutura Docker local que sobe.

## Configuração

A configuração de execução fica em `~/.teams-ai/config.json` (no contêiner: volume `teams-ai-data`). Se o arquivo não existir,
o contêiner copia `docker/config.json`. Exemplo para instalação local (sem contêiner), a partir de `config.example.json`:

```json
{
  "github": { "owner": "your-github-org-or-user" },
  "sandbox": { "enabled": true },
  "paths": {
    "workspaces": "~/.teams-ai/workspaces",
    "secrets": "~/.teams-ai/secrets",
    "runs": "~/.teams-ai/runs"
  },
  "projects": []
}
```

Variáveis de ambiente (`.env`, lido pelo `docker-compose.yml`):

| Variável | Para quê |
| --- | --- |
| `GITHUB_TOKEN` | Token do GitHub usado pelo orquestrador. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token longo do Claude, gerado por `claude setup-token`. |
| `TEAMS_AI_UI_TOKEN` | Token Bearer exigido pela UI/API. Necessário sempre que a UI não for só loopback. |
| `TEAMS_AI_UI_BIND` | Interface do host para a porta 8787. Padrão `127.0.0.1`. Use `0.0.0.0` para a rede local (com token). |
| `TEAMS_AI_ALLOWED_HOSTS` | Valores extras de `Host` que a API aceita. |
| `TEAMS_AI_UI_LOOPBACK_PUBLISHED` | `1` (padrão) publica a porta só no loopback, então nenhum token é exigido. |
| `DOCKER_GID` | ID do grupo Docker, só se você montar um socket do host (não é usado por padrão). |

## Referência da CLI

```bash
npm run teams-ai -- <comando>
```

| Comando | Descrição |
| --- | --- |
| `run --project <dir> [--spec <id>] [--run-id <id>] [--max-parallel N] [--dry-run] [--draft]` | Inicia uma execução. |
| `resume --project <dir> --run <runId>` | Continua uma execução interrompida. |
| `status --project <dir> --run <runId> [--json]` | Mostra o estado da execução. |
| `spec readme --project <dir> --spec <id>` | O SM escreve o `docs/README.md` (abre um PR de documentação). |
| `spec deploy --project <dir> --spec <id> [--target docker-local]` | Publica a `main` de novo, sem agente. |
| `supervise --project <dir> [--interval s]` | Retoma execuções interrompidas até terminarem. |
| `ui [--port N]` | Inicia a UI web e a API. |

Dentro do contêiner: `task cli -- <comando>` (equivale a `docker compose exec teams-ai npm run teams-ai -- <comando>`).

## Comandos do Task

Rode `task --list` para ver a lista atual. As tarefas de Docker funcionam em qualquer terminal; as de desenvolvimento rodam em Linux (WSL2 Ubuntu).

| Tarefa | Descrição |
| --- | --- |
| `task start` | Confere os pré-requisitos, sobe a plataforma, espera ficar saudável e abre a UI |
| `task doctor` | Confere Docker, daemon e `docker compose`; diz como corrigir o que faltar |
| `task up` | Constrói e inicia a plataforma (cria o `.env` se faltar) |
| `task down` | Para a plataforma, mantém os dados |
| `task restart` | Reinicia o orquestrador |
| `task ps` / `task logs` / `task logs:dind` | Status e logs |
| `task shell` | Shell dentro do contêiner |
| `task login:claude` / `task login:gh` | Login dentro do contêiner |
| `task cli -- <args>` | Roda a CLI do teams-ai no contêiner |
| `task reset` | Apaga contêineres, volumes e logins (pede confirmação) |
| `task install` | Instala as dependências do backend e da web |
| `task ui` / `task web:dev` | UI a partir do código / servidor Vite |
| `task typecheck` / `task test` / `task test:web` / `task web:build` | Verificações individuais |
| `task check` | Tudo o que a CI executa |
| `task wsl:setup` / `task wsl:check` | Instala e verifica as ferramentas do WSL |

Os scripts `npm run` continuam existindo (`npm test`, `npm run typecheck`, `npm run teams-ai`, `npm run ui`, ...).

A CI (GitHub Actions) roda typecheck, testes do backend, testes da web e o build da web a cada push e pull request.

## Estrutura do projeto

```text
server/    CLI, API, agentes, orquestrador, plano de execução, deploy, orçamento, decisões
web/       Interface web em React (Vite)
test/      Testes do backend e fixtures (especificação de referência: test/fixtures/todo-api)
docs/      Especificações, planos, roadmap, runbook, auditoria de segurança (docs/superpowers)
docker/    Configuração padrão usada pelo contêiner
scripts/   Setup do WSL, smoke tests, scripts de integração e avaliação
```

## Solução de problemas

| Sintoma | Solução |
| --- | --- |
| `docker compose up` falha no `dind` (`/dev/net/tun`, user namespaces) | Atualize o Docker Desktop e o WSL (`wsl --update`), mantenha o motor WSL2 ativo, depois rode `docker compose down` e `up -d --build` de novo. Veja `docker compose logs dind`. |
| A UI diz `the web UI needs util-linux script` | `sudo apt install bsdutils` (Caminho B). |
| `web/dist not found` | `npm run web:build`. |
| `paused:auth` ou "OAuth session expired" | Entre de novo no Claude em Onboarding (ou atualize `CLAUDE_CODE_OAUTH_TOKEN`) e retome a execução. |
| `403` da API em outro hostname | Adicione o hostname em `TEAMS_AI_ALLOWED_HOSTS` e defina `TEAMS_AI_UI_TOKEN` se não for loopback. |
| O contêiner reiniciou e uma execução travou | No boot, o contêiner remove arquivos `*.ndjson.lock` órfãos; depois é só retomar a execução. |
| Instalação lenta ou erros estranhos de arquivo no Caminho B | Confirme que o repositório está em `~`, não em `/mnt/c`. |
| Erro de versão do Node | É preciso Node `>=22.13` (`nvm install 22`). |

## Segurança

- Agentes só editam arquivos e devolvem JSON; o Bash é liberado apenas para papéis que precisam rodar testes. `gh`, `git push`,
  `docker` e `kubectl` são sempre negados aos agentes.
- Cada etapa de agente roda em um sandbox `bubblewrap` com um `HOME` vazio por etapa (sem credenciais de GitHub ou Docker para roubar).
- Gates e deploys rodam em um Docker aninhado sem root, sem acesso ao socket Docker do host.
- A rede de cada etapa de agente só alcança os registros de pacotes da stack do serviço: o npm sempre; o PyPI para Python; o crates.io para Rust; para Go, o `goproxy` da plataforma e o `sum.golang.org`.
- O `goproxy` é um serviço do compose que busca os módulos Go no `proxy.golang.org` e segue ele mesmo o redirecionamento ao `storage.googleapis.com`; assim nenhuma etapa alcança esse armazenamento, onde qualquer bucket serviria para vazar dados.
- Fora do compose não há `goproxy`: uma etapa Go baixa direto do `proxy.golang.org`, e um módulo cujo zip ele redireciona ao `storage.googleapis.com` não baixa dentro da etapa. Por isso rode a plataforma pelo compose.
- A UI só aceita conexões do próprio computador (loopback) por padrão. Leia `docs/superpowers/security/2026-10-04-system-audit.md` antes de expô-la.

## Mais documentação

- `docs/superpowers/ROADMAP.md`: o que já foi feito e o que falta.
- `docs/superpowers/specs/`: especificações de design. `docs/superpowers/plans/`: planos de implementação.
- `docs/superpowers/ops/runbook.md`: runbook do operador (escrito para o antigo setup com Kubernetes, substituído pelo Docker Compose; trate os comandos `kubectl` como histórico).

## Licença

Nenhuma licença foi declarada ainda.
