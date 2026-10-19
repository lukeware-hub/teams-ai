# Teams AI

[![CI](https://github.com/lukeware-hub/teams-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/lukeware-hub/teams-ai/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

Teams AI turns a product description into a tested and published service. A team of AI agents does the work
(Scrum Master, Product Owner, Developer, Tester, Security and DevOps), run by the
[Claude Code](https://docs.claude.com/en/docs/claude-code) CLI.

You do two things:

1. **Describe the project** in the web UI. The agents ask questions until the description is clear.
2. **Validate the result** after deploy. If you find problems, report them in the same specification.

Everything else (technical spec, task plan, code, tests, review, commits, pull requests, merge and deploy) is done by
the agents, under the control of a deterministic orchestrator.

> **Core rule:** agents decide, propose and generate. The orchestrator validates, executes and changes state.
> An agent never runs `git push`, `gh`, `docker` or `kubectl`. The orchestrator does.

## Quick start (Windows)

1. In PowerShell **as Administrator**, in the project folder, install the prerequisites (WSL2, Git, Docker Desktop and Task).
   The script skips what is already installed:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
   ```

2. Restart if asked. Open Docker Desktop and wait for "Engine running". Then, in a new terminal in the project folder:

   ```bash
   task start
   ```

   The command checks the prerequisites (if something is missing, it tells you how to fix it), starts the platform,
   waits until it is healthy and opens <http://localhost:8787>. The first run downloads the ready-made image, which
   takes a few minutes. If the download fails, the image is built from the source, which takes longer.

3. The first screen asks for a license key. Then follow the **Onboarding** page to connect GitHub and Claude.
   See [First access](#first-access-connect-your-accounts) and [License service](#license-service).

If something does not start, run `task doctor`.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [First access](#first-access-connect-your-accounts)
- [License service](#license-service)
- [Using Teams AI](#using-teams-ai)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Task commands](#task-commands)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [More documentation](#more-documentation)
- [License](#license)

## How it works

```text
You: describe the project (UI)
        |
        v
 Gate 1 - Refinement    SM and PO agents ask questions until the documentation is clear
        |
        v
 Plan                   SM builds the task graph; Dev writes the technical spec
        |
        v
 Execution (parallel)   Dev / Test / Security / DevOps agents work in git worktrees;
                        the orchestrator runs lint, tests and gates, opens PRs and merges
        |
        v
 Deploy                 `docker-local` target, plus smoke and e2e tests
        |
        v
You: validate (UI)      Problems return to Gate 1 as a continuation of the same specification
```

Main parts:

| Part | What it does |
| --- | --- |
| Orchestrator (`server/orchestrator`) | Event-driven state machine. One `claude -p` process per agent step. The journal is append-only, so nothing is lost if the process stops. |
| Agents (`server/agents`) | Roles `sm`, `po`, `dev`, `front`, `test`, `sec`, `devops` and `env`, each with restricted permissions. |
| Execution (`server/exec`, `server/deploy`) | Runs gates (tests, scans) and deploys in a rootless nested Docker, never in your computer's Docker. |
| Budget (`server/budget`) | Tracks tokens and cost. Pauses when the Claude subscription window is nearly full and resumes on its own. |
| Decision layer (`server/decide`) | Optional. Answers simple decisions locally before calling Claude. |
| Knowledge (`server/knowledge`) | Searches project context, optionally with `graphify`. |
| API and web UI (`server/api`, `web`) | Onboarding, projects, refinement chat, live run tracking and validation. Served on port `8787`. |
| License service (repository `lukeware-hub/teams-ai-license`) | Separate service with its own administration and PostgreSQL. Runs on the `teams-ai-net` network. |
| Supervisor (`server/supervisor`) | Resumes interrupted runs until they finish. |

## Requirements

- Windows 10 (22H2) or Windows 11, with virtualization enabled in BIOS/UEFI. Recommended: 16 GB RAM and 30 GB free disk.
- A **Claude subscription** that works with Claude Code (Pro, Max or Team). The project does not use `ANTHROPIC_API_KEY`.
- A **GitHub account** (user or organization) where the generated projects are created, and a personal access token for it.
- An **OpenRouter key**. The Jev agent, which checks document consistency and decides refinement points, needs it. Without it, refinement does not start.

Why not run directly on Windows? The orchestrator is a Linux program: the UI uses util-linux `script`, agent steps use
`bubblewrap` sandboxes, and gates run in Linux containers. On Windows it runs inside Docker Desktop (Path A) or WSL2 (Path B).

## Installation

### Step 0: enable WSL2

In PowerShell as Administrator:

```powershell
wsl --install -d Ubuntu
```

Restart if asked. Open "Ubuntu" from the Start menu once and create your Linux user and password.
Check that the version is WSL 2:

```powershell
wsl -l -v      # Ubuntu must show VERSION 2
```

### Step 1: install Git, Docker Desktop and Task

```powershell
winget install --id Git.Git -e
winget install --id Docker.DockerDesktop -e
winget install --id Task.Task -e
```

[Task](https://taskfile.dev) runs the project commands defined in `Taskfile.yml`. Open a new terminal and run `task --list`
to see them all.

Open Docker Desktop and wait for "Engine running". In **Settings**:

- **General**: enable "Use the WSL 2 based engine".
- **Resources > WSL Integration**: enable your Ubuntu distribution (only needed for Path B).

Check:

```powershell
docker --version
docker compose version
```

### Path A: Docker Desktop (recommended)

Starts the whole platform (orchestrator, API, web UI and a rootless nested Docker) with one command.

1. Clone the repository. For better file performance and fewer line-ending problems, clone from inside Ubuntu:

   ```powershell
   wsl -d Ubuntu
   ```

   ```bash
   git clone https://github.com/lukeware-hub/teams-ai.git
   cd teams-ai
   ```

   Cloning from Windows also works; the repository has a `.gitattributes` file.

2. Create the environment file (`task up` also creates it if it is missing):

   ```bash
   task setup
   ```

   All keys are optional. You can set them later in the UI:

   ```dotenv
   # GITHUB_TOKEN=ghp_xxx          # token that creates repositories and PRs in your account or organization
   # CLAUDE_CODE_OAUTH_TOKEN=      # long token from `claude setup-token` (skips the browser login)
   ```

3. Start the license service first, as in [License service](#license-service). Teams AI expects it to respond.

4. Build and start:

   ```bash
   task up        # pulls the ready-made image and starts; builds from source if the pull fails
   ```

   The image is a private package on GitHub Container Registry. Before the first `task up`, log in once with a classic
   GitHub token that has the `read:packages` scope:

   ```bash
   echo YOUR_TOKEN | docker login ghcr.io -u YOUR_USER --password-stdin
   ```

   Without this login, the pull fails and Docker builds the image on your computer, which takes a few minutes.
   To pin a version, set `TEAMS_AI_IMAGE=ghcr.io/lukeware-hub/teams-ai:v1.2.3` in `.env`. The image tag is always the git tag that published it.
   To develop Teams AI itself, use `task up:source`, which builds the image from this folder.
   The published image is for amd64 processors. On Apple Silicon Macs, use `task up:source`.

5. Wait for the services to become healthy, then open the UI:

   ```bash
   task ps
   ```

   Go to <http://localhost:8787>.

6. Continue with [First access](#first-access-connect-your-accounts).

Useful commands:

```bash
task logs       # follow orchestrator logs
task restart    # restart the orchestrator
task down       # stop everything (keeps your data)
task shell      # open a shell inside the container
task reset      # stop and DELETE all data, logins and workspaces (asks for confirmation)
```

Your data lives in named Docker volumes: `teams-ai-data` (configuration, workspaces, runs and secrets),
`teams-ai-claude` (Claude login), `teams-ai-gh` (GitHub CLI login) and `dind-data` (nested Docker images).
The license database lives in the license service, in its own repository.

To share the UI on your local network, set `TEAMS_AI_UI_BIND=0.0.0.0` in `.env` and add the hostname you use to
`TEAMS_AI_ALLOWED_HOSTS`. The UI has no password. With `0.0.0.0`, any computer on the network has full API access.
Use this only on a trusted network.

### Path B: WSL2 from source (development)

Use this to change the code, run the tests or use the CLI directly. Run everything **inside Ubuntu** (`wsl -d Ubuntu`).
Keep the repository in the Linux file system (`~/teams-ai`), not in `/mnt/c`.

1. Clone:

   ```bash
   git clone https://github.com/lukeware-hub/teams-ai.git ~/teams-ai
   cd ~/teams-ai
   ```

2. Install the tools. The script can run more than once:

   ```bash
   task wsl:setup     # runs scripts/wsl/setup-ubuntu.sh
   ```

   It installs, in this order:

   | Tool | Purpose | How the script installs it |
   | --- | --- | --- |
   | apt packages: `curl git unzip build-essential cmake python3 pipx bubblewrap socat` | build basics; `bubblewrap` and `socat` are needed by the Claude Code sandbox | `apt-get` |
   | Node.js 22 | runtime (`>=22.13`) | `nvm` (also added to `~/.profile`) |
   | Claude Code CLI | runs the agents | `npm install -g @anthropic-ai/claude-code` |
   | GitHub CLI `gh` | PRs, merges and repository creation (run by the orchestrator) | GitHub apt repository |
   | `gitleaks`, `osv-scanner` | secret and dependency scans used as gates | GitHub release binaries |
   | `graphify` | optional knowledge graph | `pipx install graphifyy` |
   | Docker | gates and deploys | **not installed here**: comes from Docker Desktop WSL integration (Step 1) |

   If `script` (util-linux) is missing, install it with `sudo apt install bsdutils`. The UI needs it for the login terminal.

3. Check the tools. It prints a JSON report; every tool you need must show `"present":true`:

   ```bash
   task wsl:check
   ```

4. Install the project dependencies and build the web UI:

   ```bash
   task install
   task web:build
   ```

5. Run the checks (optional but recommended; CI runs the same):

   ```bash
   task check
   ```

6. Start the UI:

   ```bash
   task ui
   ```

   Open <http://localhost:8787> in Windows (WSL2 forwards localhost). For live reload while developing the UI, use
   `task web:dev` (Vite server with `/api` proxied).

7. Create your configuration (optional; the defaults work):

   ```bash
   mkdir -p ~/.teams-ai
   cp config.example.json ~/.teams-ai/config.json
   ```

   Set `github.owner`. For a local install (without Compose), **remove the `docker.bindRewrite` block** from the copied file.
   It is only for the container deployment. See [Configuration](#configuration).

## First access: connect your accounts

Open <http://localhost:8787>. The first time, the license key screen comes first, then onboarding has 7 steps.
A computer that is already activated skips the license screen and gets the 6 remaining steps.
The **Onboarding** page lists what must be green before you run anything. Each item updates live.

| Item | What to do |
| --- | --- |
| **License** | Paste the key generated in the license service. It is checked once and is not stored in Teams AI. See [License service](#license-service). |
| **Claude** | Click the login button and follow the browser flow in the embedded terminal (`claude auth login`). Or run `task login:claude`. Alternative: run `claude setup-token` anywhere, put the result in `CLAUDE_CODE_OAUTH_TOKEN` in `.env`, then run `docker compose up -d`. |
| **GitHub owner** | Enter the GitHub user or organization that owns the generated repositories. |
| **GitHub login (`gh`)** | Log in with `gh auth login` in the embedded terminal, or run `task login:gh`. |
| **GitHub token** | Paste a personal access token. Classic: `repo` and `workflow` scopes. Fine-grained: permission to create repositories and access contents, pull requests and workflows. It is stored in `~/.teams-ai/secrets` and never shown again. |
| **OpenRouter key** | Paste the OpenRouter API key. Jev uses it to check documents and classify criteria and questions. Refinement does not start without it. |

When all items are green, you are ready.

## License service

Teams AI opens only after the license service authorizes this computer. The service is a separate repository,
[lukeware-hub/teams-ai-license](https://github.com/lukeware-hub/teams-ai-license), with its own administration and PostgreSQL.
It runs in its own `docker compose`, on the `teams-ai-net` network.

Its administration page is at <http://localhost:8790>, reachable only from this computer. Use that repository's tasks to start,
stop or view the logs of the service.

In the root `.env`, `LICENSE_SERVICE_URL` points Teams AI to the service. In Compose the default is `http://license:8080`.

To register a computer:

1. Open <http://localhost:8790> and create a license. The screen shows the key once; the administrator can view it again later.
2. On the first Teams AI screen, paste that key. Teams AI sends only a hash and stores a code in `~/.teams-ai/license/code`.
   The key itself is not kept in Teams AI.
3. On each start, Teams AI asks the service whether that code is still valid.

A license can expire on a date, after a number of days counted from activation, or never. The administrator can turn a license on or off at any time.
If it is off or expired, Teams AI shows the contact e-mail and phone configured in the service settings and asks the user to contact Lukeware.
If the service does not respond, Teams AI stays on that screen until the service is back.

## Using Teams AI

1. **Add a project** on the Projects page (name, GitHub repository and local workspace).
2. **Refine** (Gate 1): describe what the project is, what it does, who uses it and its goals. Tasks and stack are optional.
   Answer the questions from the SM and PO agents until they accept the documentation.
3. **Start the run.** Follow it live on the Run page (events, tasks, tokens and cost). You can **Stop** (the current step
   finishes first) and **Resume** later. If the Claude subscription window is nearly full, the run shows
   `paused:quota` and continues by itself when the window resets.
4. **Validate.** When a run reaches `awaiting-validation`, the service is already deployed (`docker-local`) and the smoke and e2e
   tests passed. Try it, then accept it or report problems. Problems return to Gate 1 as a continuation of the same specification.

The **Help chat** answers questions about the project and about using Teams AI. It searches the user guide in `docs/guia/`.
When you change a screen or button, update the guide and run `task guia:grafo` to rebuild its search graph.

Run statuses you will see: `running`, `paused:quota`, `paused:auth`, `draining`, `interrupted`, `blocked`, `deadlocked`,
`phase-failed` and `done`. `paused:auth` means the Claude login expired. Log in again, then click Resume.

Every generated project must deliver the full contract: code, documentation, unit and e2e tests, security scans,
GitHub Actions, image build, and a local Docker infrastructure that starts.

## Configuration

The run configuration is in `~/.teams-ai/config.json` (in the container: volume `teams-ai-data`). If the file does not exist,
the container copies `docker/config.json`. Example for a local install, based on `config.example.json`:

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

Environment variables (`.env`, read by `docker-compose.yml`):

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | GitHub token used by the orchestrator. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Long-lived Claude token from `claude setup-token`. |
| `TEAMS_AI_UI_BIND` | Host interface for port 8787. Default `127.0.0.1`. Use `0.0.0.0` only on a trusted network. |
| `TEAMS_AI_ALLOWED_HOSTS` | Extra `Host` header values the API accepts. |
| `TEAMS_AI_REFINE_RELEASE_ROUNDS` | Refinement rounds after which Executar opens with checks still failing. Default `5`. |
| `TEAMS_AI_REFINE_MAX_ROUNDS` | Refinement rounds after which Reavaliar stops and asks for a decision. Default `10`. |
| `TEAMS_AI_IMAGE` | Image to run instead of the default registry image. |
| `LICENSE_SERVICE_URL` | Address of the license service. In Compose the default is `http://license:8080`. |

## CLI reference

```bash
npm run teams-ai -- <command>
```

| Command | Description |
| --- | --- |
| `run --project <dir> [--spec <id>] [--run-id <id>] [--max-parallel N] [--dry-run] [--draft]` | Starts a run. |
| `resume --project <dir> --run <runId>` | Continues an interrupted run. |
| `status --project <dir> --run <runId> [--json]` | Shows the run state. |
| `spec readme --project <dir> --spec <id>` | The SM writes `docs/README.md` (opens a documentation PR). |
| `spec deploy --project <dir> --spec <id> [--target docker-local]` | Deploys `main` again, without an agent. |
| `supervise --project <dir> [--interval s]` | Resumes interrupted runs until they finish. |
| `ui [--port N]` | Starts the web UI and API. |

Inside the container: `task cli -- <command>` (same as `docker compose exec teams-ai npm run teams-ai -- <command>`).

## Task commands

Run `task --list` for the current list. Docker tasks work in any terminal; development tasks run on Linux (WSL2 Ubuntu).

| Task | Description |
| --- | --- |
| `task start` | Checks prerequisites, starts the platform, waits until healthy and opens the UI |
| `task doctor` | Checks Docker, the daemon and `docker compose`; tells you how to fix what is missing |
| `task up` | Pulls the ready-made image (builds if the pull fails) and starts the platform (creates `.env` if missing) |
| `task up:source` | Builds the image from this folder and starts the platform (for developing Teams AI) |
| `task down` | Stops the platform, keeps data |
| `task restart` | Restarts the orchestrator |
| `task ps` / `task logs` / `task logs:dind` | Status and logs |
| `task shell` | Shell inside the container |
| `task login:claude` / `task login:gh` | Login inside the container |
| `task cli -- <args>` | Runs the teams-ai CLI in the container |
| `task reset` | Deletes containers, volumes and logins (asks for confirmation) |
| `task install` | Installs backend and web dependencies |
| `task ui` / `task web:dev` | UI from source / Vite dev server |
| `task typecheck` / `task test` / `task test:web` / `task web:build` | Individual checks |
| `task check` | Everything CI runs |
| `task wsl:setup` / `task wsl:check` | Installs and checks the WSL tools |

The npm scripts also work: `npm test`, `npm run typecheck`, `npm run teams-ai`, `npm run ui`, `npm run web:build`.

CI (GitHub Actions) runs only when a release is published. It runs typecheck, backend tests, web tests and the web build, then builds the image under the release tag such as `v1.2.3`, scans it for critical vulnerabilities, and publishes the tag and `latest` only if the scan passes.

## Project structure

```text
server/    CLI, API, agents, orchestrator, execution, deploy, budget, decisions
web/       React web UI (Vite)
test/      Backend tests and fixtures (reference spec: test/fixtures/todo-api)
docs/      Specs, plans, roadmap, runbook, security audit (docs/superpowers) and user guide (docs/guia)
docker/    Default configuration used by the container
scripts/   WSL setup, smoke tests, integration and evaluation scripts
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `docker compose up` fails in `dind` (`/dev/net/tun`, user namespaces) | Update Docker Desktop and WSL (`wsl --update`), keep the WSL2 engine on, then run `docker compose down` and `docker compose up -d --build`. See `docker compose logs dind`. |
| The UI says `the web UI needs util-linux script` | `sudo apt install bsdutils` (Path B). |
| `web/dist not found` | `task web:build`. |
| `paused:auth` or "OAuth session expired" | Log in to Claude again in Onboarding (or update `CLAUDE_CODE_OAUTH_TOKEN`), then resume the run. |
| `403` from the API on another hostname | Add the hostname to `TEAMS_AI_ALLOWED_HOSTS`. |
| The container restarted and a run is stuck | On boot, the container removes orphan `*.ndjson.lock` files. Then resume the run. |
| Slow install or odd file errors in Path B | Make sure the repository is in `~`, not `/mnt/c`. |
| Node version error | Node `>=22.13` is required (`nvm install 22`). |
| The UI asks you to contact Lukeware | The license is off or expired. The contact details on that screen come from the service settings. |
| The UI says the license service does not respond | Check the license service logs (in its repository) and `LICENSE_SERVICE_URL`. Teams AI waits for the service to come back. |

## Security

- Agents only edit files and return JSON. Bash is allowed only for roles that run tests. `gh`, `git push`,
  `docker` and `kubectl` are always denied to agents.
- Each agent step runs in a `bubblewrap` sandbox with an empty `HOME` per step, so there are no GitHub or Docker credentials to steal.
- Gates and deploys run in a rootless nested Docker, with no access to the host Docker socket.
- Agent steps can reach only the package registries of their stack: npm always; PyPI for Python; crates.io for Rust; for Go, the
  platform `goproxy` and `sum.golang.org`.
- Run the platform with Compose. Outside Compose there is no `goproxy`, and Go modules that redirect to `storage.googleapis.com` fail inside a step.
- The UI accepts connections from this computer only (loopback) by default. Read `docs/superpowers/security/2026-10-04-system-audit.md` before exposing it.

## More documentation

- `docs/superpowers/BACKLOG.md`: known system bugs, with evidence for each.
- `docs/superpowers/specs/`: design specifications. `docs/superpowers/plans/`: implementation plans.
- `docs/superpowers/ops/runbook.md`: operator runbook for Docker Compose: runs, quota, journal, health, volume backup and restore.

## License

No license has been declared yet.
