import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCommand, type Exec } from '../../server/exec/command.js';
import { withGhAuth, withGitAuth } from '../../server/git/auth.js';
import { createAnnotatedTag, git, pushMain, pushTags, remoteTagTarget } from '../../server/git/git.js';
import { createPrivateRepo, repoInfo } from '../../server/git/github.js';

/** Probe of the documentation store primitives on a throwaway private repository: create, push, tag, read, reject, delete. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const report: Record<string, unknown> = {};
let created = false;

/** The owner from the command line; the probe refuses to run without --owner and --throwaway. */
function ownerFrom(args: string[]): string {
  const at = args.indexOf('--owner');
  const owner = at >= 0 ? args[at + 1] : undefined;
  if (owner === undefined || !GITHUB_LOGIN.test(owner) || !args.includes('--throwaway')) {
    throw new Error('Refused: pass --owner <login> and --throwaway. The probe creates and deletes a private repository.');
  }
  return owner;
}

async function commitEmpty(dir: string, message: string): Promise<string> {
  await git(dir, ['commit', '--allow-empty', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/** The steps of the probe; each result is kept for the report. */
async function probe(work: string, target: { owner: string; name: string }, exec: Exec): Promise<void> {
  const fullName = `${target.owner}/${target.name}`;
  const url = `https://github.com/${fullName}.git`;
  await createPrivateRepo(target, exec);
  created = true;
  const repo = path.join(work, 'repo');
  const other = path.join(work, 'other');
  await fs.mkdir(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(repo, 'README.md'), 'probe\n');
  await git(repo, ['add', '-A']);
  const first = await commitEmpty(repo, 'docs: probe');
  await git(repo, ['remote', 'add', 'origin', url]);
  report.pushMain = await pushMain(repo, first, exec);
  await createAnnotatedTag(repo, 'dev-start/probe', first, 'probe');
  report.pushTags = await pushTags(repo, ['dev-start/probe'], exec);
  report.remoteTagTarget = await remoteTagTarget(repo, 'dev-start/probe', exec);
  report.repoInfo = await repoInfo(repo, fullName, exec);
  await git(work, ['clone', '-q', url, other], exec);
  const ahead = await commitEmpty(other, 'docs: other side');
  report.pushOther = await pushMain(other, ahead, exec);
  const mine = await commitEmpty(repo, 'docs: mine');
  report.pushDivergent = await pushMain(repo, mine, exec);
}

async function deleteRepo(fullName: string, exec: Exec): Promise<string> {
  const r = await exec({ bin: 'gh', args: ['repo', 'delete', fullName, '--yes'], timeoutMs: 120_000, env: { GH_PROMPT_DISABLED: '1' } });
  return r.exitCode === 0 ? 'deleted' : `not deleted: ${r.stderr.trim()}`;
}

async function writeReport(date: string, fullName: string): Promise<string> {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/superpowers/probes');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}-docs-store.md`);
  const body = [
    `# Probe: documentation store primitives (${date})`,
    '',
    `Throwaway repository ${fullName}; deletion: ${report.deletion}.`,
    '',
    '## Raw gh JSON fields',
    '',
    '```json',
    JSON.stringify(report.repoInfo, null, 2),
    '```',
    '',
    '## Push and tag results (stderr as given on a rejection)',
    '',
    '```json',
    JSON.stringify({ pushMain: report.pushMain, pushTags: report.pushTags, pushOther: report.pushOther, pushDivergent: report.pushDivergent, remoteTagTarget: report.remoteTagTarget, error: report.error ?? null }, null, 2),
    '```',
    '',
  ].join('\n');
  await fs.writeFile(file, body);
  return file;
}

async function main(): Promise<void> {
  const owner = ownerFrom(process.argv.slice(2));
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const name = `teams-ai-probe-${date.replaceAll('-', '')}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const fullName = `${owner}/${name}`;
  const secretsDir = path.join(os.homedir(), '.teams-ai', 'secrets');
  const base: Exec = withGhAuth(withGitAuth(execCommand, secretsDir), secretsDir);
  // On Windows the gh login lives in the keyring, which the command environment does not forward: pass the token the caller set.
  const token = process.env.GH_TOKEN;
  const exec: Exec = (spec) => (spec.bin === 'gh' && token ? base({ ...spec, env: { ...(spec.env ?? {}), GH_TOKEN: token } }) : base(spec));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-probe-'));
  try {
    await probe(work, { owner, name }, exec);
  } catch (err) {
    report.error = String(err);
  } finally {
    // Only a repository this run created is deleted; a name taken before the run is never touched.
    report.deletion = created ? await deleteRepo(fullName, exec) : 'not created by this run, so nothing was deleted';
    await fs.rm(work, { recursive: true, force: true });
    console.log(`report: ${await writeReport(date, fullName)}`);
    process.exitCode = report.error ? 1 : 0;
  }
}

// Run only when this file is the entry point, so importing it never creates or deletes a repository.
if (path.basename(process.argv[1] ?? '') === 'docs-store.ts') {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
