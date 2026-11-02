import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { runRoutes } from '../../server/api/run-routes.js';
import { startApi } from '../../server/api/server.js';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { docsStoreDir, writeDocsMarker } from '../../server/docs/project-state.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { workspacePaths } from '../../server/orchestrator/workspace.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
const DOCS_ONLY = 'este repositório guarda só a documentação; importar por link ainda não é suportado nesta versão';
let home = '';
let runs = '';
let api: { port: number; close(): Promise<void> };

const base = () => `http://127.0.0.1:${api.port}`;
const post = (p: string, body: unknown) => fetch(`${base()}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const started = { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } };
const finished = { runId: 'hello-001-r1', at: '2026-09-24T10:01:00.000Z', status: 'awaiting-validation', tasks: [], tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, steps: 1 } };
const control = {
  spawn: () => {
    throw new Error('this test starts no run');
  },
  kill: () => false,
  sleep: async () => {},
  cliEntry: () => ({ bin: 'node', prefix: ['cli'] }),
  repoRoot: '/repo',
} as RunControlDeps;

/** Makes `dest` a clone of a one-commit repository whose main holds docs/README.md with `text`. */
async function cloneWithReadme(dest: string, text: string): Promise<void> {
  const seed = await fs.mkdtemp(path.join(home, 'seed-'));
  await fs.mkdir(path.join(seed, 'docs'), { recursive: true });
  await fs.writeFile(path.join(seed, 'docs', 'README.md'), text);
  const git = (args: string[], cwd: string) => execCommand({ bin: 'git', args: ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], cwd, timeoutMs: 30_000 });
  await git(['init', '-b', 'main'], seed);
  await git(['add', '-A'], seed);
  await git(['commit', '-m', 'docs'], seed);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await git(['clone', seed, dest], path.dirname(dest));
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-lane4-'));
  runs = path.join(home, 'runs');
  await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
  await fs.writeFile(path.join(home, '.teams-ai', 'config.json'), JSON.stringify({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }));
  api = await startApi({
    routes: runRoutes({
      cfg: async () => (await readUserConfig(home)).cfg,
      home,
      control,
      cloneProject: async (url, destination) => {
        if (url.includes('docs-only')) {
          await fs.mkdir(path.join(destination, 'docs'), { recursive: true });
          await fs.writeFile(path.join(destination, 'docs', 'project.md'), '# Projeto\n');
        } else await fs.cp(HELLO, destination, { recursive: true });
      },
    }),
  }, 0);
});

afterEach(async () => {
  await api.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe('import by link', () => {
  it('refuses a repository that holds only documents, with the reason in Portuguese', async () => {
    const res = await post('/api/projects', { url: 'https://github.com/acme/docs-only.git' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(DOCS_ONLY);
  });

  it('still imports a repository that has docs/project.json', async () => {
    const res = await post('/api/projects', { url: 'https://github.com/acme/hello-app.git' });
    expect(res.status).toBe(200);
  });
});

describe('README of a project', () => {
  it('a documentation repository reads its README from the documents store, not from the code repository', async () => {
    const ws = workspacePaths((await readUserConfig(home)).cfg, 'hello-app', home);
    await writeDocsMarker(ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'hello-app' }, firstSha: null });
    await cloneWithReadme(docsStoreDir(ws), '# Documentação\n');
    await cloneWithReadme(ws.repo, '# Código\n');
    await writeRun(runs, 'hello-001-r1', [started], finished);
    const d = await (await fetch(`${base()}/api/runs/hello-001-r1`)).json();
    expect(d.readme).toBe('# Documentação\n');
  });

  it('a legacy project keeps reading the README of origin/main in its repository', async () => {
    await cloneWithReadme(workspacePaths((await readUserConfig(home)).cfg, 'hello-app', home).repo, '# Saudação\n');
    await writeRun(runs, 'hello-001-r1', [started], finished);
    const d = await (await fetch(`${base()}/api/runs/hello-001-r1`)).json();
    expect(d.readme).toBe('# Saudação\n');
  });
});
