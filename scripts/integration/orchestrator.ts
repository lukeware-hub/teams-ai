/**
 * Manual, live: the whole orchestrator on a fixture (default hello-app) with the real claude, Docker and GitHub.
 *   TEAMS_AI_GH_OWNER=<owner> [TEAMS_AI_FIXTURE=todo-api] npx tsx --no-warnings=ExperimentalWarning scripts/integration/orchestrator.ts
 * Creates (or reuses) the repository <owner>/teams-ai-<fixture>, pushes docs/ to main, then runs Phases 1–3.
 * Costs real tokens (one Opus tech spec, one plan, one Dev + one review per task). Never part of `npm test`.
 *
 * Run it from the repository root. To repeat from scratch, delete the GitHub repository
 * (`gh repo delete <owner>/teams-ai-<fixture>`), `rm -rf ~/.teams-ai/workspaces/<fixture>` and the
 * `~/.teams-ai/runs/<specId>-*` directories: reusing the repository with a new run would find the old
 * task PRs already merged and report `complete` without merging new work.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../server/config/config.js';
import { Spec, computeSpecHash } from '../../server/contracts/spec.js';
import { loadSecrets } from '../../server/core/secrets.js';
import { execCommand, type Exec } from '../../server/exec/command.js';
import { ensureRepo } from '../../server/git/github.js';
import { git } from '../../server/git/git.js';
import { main } from '../../server/cli.js';
import { expandHome, workspacePaths } from '../../server/orchestrator/workspace.js';

const owner = process.env.TEAMS_AI_GH_OWNER;
if (!owner) {
  console.error('TEAMS_AI_GH_OWNER is required');
  process.exit(2);
}
const cfg = loadConfig(JSON.parse(await fs.readFile(path.join(os.homedir(), '.teams-ai', 'config.json'), 'utf8').catch(() => '{}')));
const name = process.env.TEAMS_AI_FIXTURE ?? 'hello-app';
const ws = workspacePaths(cfg, name);
// Repository creation runs as the token's user (the orchestrator's identity), not as the interactive gh login.
const secrets = await loadSecrets(expandHome(cfg.paths.secrets));
const ghExec: Exec = (spec) => execCommand({ ...spec, env: { ...(spec.env ?? {}), ...(secrets.GITHUB_TOKEN ? { GH_TOKEN: secrets.GITHUB_TOKEN } : {}) } });
const fixture = path.resolve('test/fixtures', name);
await fs.access(path.join(fixture, 'docs', 'project.json')).catch(() => {
  console.error('run this script from the repository root');
  process.exit(2);
});
const [specId] = await fs.readdir(path.join(fixture, 'docs', 'specs'));

await fs.mkdir(ws.root, { recursive: true });
try {
  await fs.access(path.join(ws.repo, '.git'));
} catch {
  await fs.cp(fixture, ws.repo, { recursive: true });
  const specFile = path.join(ws.repo, 'docs', 'specs', specId!, 'spec.json');
  const spec = Spec.parse(JSON.parse(await fs.readFile(specFile, 'utf8')));
  if (!spec.specHash) await fs.writeFile(specFile, `${JSON.stringify({ ...spec, specHash: computeSpecHash(spec) }, null, 2)}\n`);
  await git(ws.repo, ['init', '-b', 'main']);
  await git(ws.repo, ['add', '-A']);
  await git(ws.repo, ['commit', '-q', '-m', `docs: ${name} contracts`]);
  const repo = await ensureRepo({ owner, name: `teams-ai-${name}`, private: true, cwd: ws.repo }, ghExec);
  console.error(`repository ${repo.fullName} (${repo.created ? 'created' : 'reused'})`);
}

const started = Date.now();
const code = await main({ argv: ['run', '--project', ws.repo, '--spec', specId!], env: process.env, stdout: (s) => console.log(s), stderr: (s) => console.error(s) });
console.error(`exit ${code} after ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(code);
