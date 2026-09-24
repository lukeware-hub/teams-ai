/**
 * Manual, live: the whole orchestrator on the hello-app fixture with the real claude, Docker and GitHub.
 *   TEAMS_AI_GH_OWNER=<owner> npx tsx --no-warnings=ExperimentalWarning scripts/integration/orchestrator.ts
 * Creates (or reuses) the repository <owner>/teams-ai-hello-app, pushes docs/ to main, then runs Phases 1–3.
 * Costs real tokens (one Opus tech spec, one plan, one Dev + one review per task). Never part of `npm test`.
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
const ws = workspacePaths(cfg, 'hello-app');
// Repository creation runs as the token's user (the orchestrator's identity), not as the interactive gh login.
const secrets = await loadSecrets(expandHome(cfg.paths.secrets));
const ghExec: Exec = (spec) => execCommand({ ...spec, env: { ...(spec.env ?? {}), ...(secrets.GITHUB_TOKEN ? { GH_TOKEN: secrets.GITHUB_TOKEN } : {}) } });
const fixture = path.resolve('test/fixtures/hello-app');

await fs.mkdir(ws.root, { recursive: true });
try {
  await fs.access(path.join(ws.repo, '.git'));
} catch {
  await fs.cp(fixture, ws.repo, { recursive: true });
  const specFile = path.join(ws.repo, 'docs', 'specs', 'hello-001', 'spec.json');
  const spec = Spec.parse(JSON.parse(await fs.readFile(specFile, 'utf8')));
  if (!spec.specHash) await fs.writeFile(specFile, `${JSON.stringify({ ...spec, specHash: computeSpecHash(spec) }, null, 2)}\n`);
  await git(ws.repo, ['init', '-b', 'main']);
  await git(ws.repo, ['add', '-A']);
  await git(ws.repo, ['commit', '-q', '-m', 'docs: hello-app contracts']);
  const repo = await ensureRepo({ owner, name: 'teams-ai-hello-app', private: true, cwd: ws.repo }, ghExec);
  console.error(`repository ${repo.fullName} (${repo.created ? 'created' : 'reused'})`);
}

const started = Date.now();
const code = await main({ argv: ['run', '--project', ws.repo, '--spec', 'hello-001'], env: process.env, stdout: (s) => console.log(s), stderr: (s) => console.error(s) });
console.error(`exit ${code} after ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(code);
