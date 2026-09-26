# Teams AI

[![CI](https://github.com/diego-dm-morais/teams-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/diego-dm-morais/teams-ai/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/github/actions/workflow/status/diego-dm-morais/teams-ai/ci.yml?label=tests&logo=vitest)](https://github.com/diego-dm-morais/teams-ai/actions/workflows/ci.yml)

Teams AI is a TypeScript toolkit for running, coordinating, and observing AI-assisted development workflows. It includes a CLI, a web UI, agent orchestration, budget controls, execution evidence, and knowledge retrieval utilities.

## Highlights

- CLI for running and inspecting AI workflows
- Agent registry and decision-making pipeline
- Budget, quota, and progress controls
- Run history, evidence, and journal APIs
- React web UI for workflow visibility
- Unit and integration tests with Vitest

## Requirements

- Node.js `>=22.12`
- npm

## Getting started

```bash
npm ci
npm test
npm run typecheck
npm run web:build
```

Start the CLI:

```bash
npm run teams-ai -- --help
```

Start the web UI in development mode:

```bash
npm run web:install
npm run web:dev
```

## Development commands

| Command | Description |
| --- | --- |
| `npm test` | Run backend tests |
| `npm run test:web` | Run web UI tests |
| `npm run typecheck` | Check TypeScript types |
| `npm run web:build` | Type-check and build the web UI |
| `npm run teams-ai` | Run the CLI |
| `npm run ui` | Run the CLI web UI command |

## Project structure

```text
server/   CLI, APIs, agents, execution, and orchestration
web/      React web interface
test/     Backend tests and fixtures
docs/     Project documentation and plans
scripts/  Development and maintenance scripts
```

## Quality signals

The repository runs its typecheck, backend tests, web tests, and web production build in GitHub Actions on every push and pull request.

### Commit activity

![Commit activity](https://github-readme-activity-graph.vercel.app/graph?username=diego-dm-morais&repo=teams-ai&hide_border=true&area=true)

### Repository statistics

![Repository stats](https://github-readme-stats.vercel.app/api?username=diego-dm-morais&show_icons=true&hide_title=true&hide_rank=true&count_private=true)

## License

No license has been declared yet.
