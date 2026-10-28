import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prepareGateImage, runGate } from '../../exec/gate-runner.js';
import { androidToolchainOf, stackKind } from '../../runner/stacks.js';
import { OrchEvent } from '../events.js';
import type { Phase5Result } from './deploy.js';
import type { PhaseDeps } from './shared.js';

/**
 * A mobile plan's delivery: install and build on the checkout of main, in the gate image, then keep the artifact with the run.
 * Nothing is deployed and no port is published; the owner downloads the file from the validation page.
 */
export async function runArtifact(deps: PhaseDeps, attempt: number): Promise<Phase5Result> {
  const plan = deps.plan!;
  const artifact = plan.deploy.artifact!;
  if (!deps.artifactsDir) return { ok: false, reason: 'no run folder to keep the mobile artifact in' };
  const image = await prepareGateImage(plan.gateImage, deps.exec, { android: androidToolchainOf(stackKind(plan.stack)) });
  const ctx = { worktree: deps.ws.repo, image, junitPath: plan.junitPath, cpus: 2, memory: '2g', timeoutMs: 25 * 60_000, secrets: {}, containerName: `teams-ai-artifact-${attempt}` };
  const io = { exec: deps.exec, readFile: (f: string) => fs.readFile(f, 'utf8').catch(() => null), removeFile: (f: string) => fs.rm(f, { force: true }) };
  if (plan.commands.install) {
    const install = await runGate({ name: 'install', command: plan.commands.install, blocking: true, network: 'egress', secrets: [] }, ctx, io);
    if (!install.passed) return { ok: false, reason: `mobile install failed: ${install.stderrTail.slice(-300)}` };
  }
  const build = await runGate({ name: 'build', command: plan.commands.build, blocking: true, network: 'none', secrets: [] }, ctx, io);
  if (!build.passed) return { ok: false, reason: `mobile build failed: ${build.stderrTail.slice(-300)}` };
  const name = path.basename(artifact);
  await fs.mkdir(deps.artifactsDir, { recursive: true });
  try {
    await fs.copyFile(path.join(deps.ws.repo, artifact), path.join(deps.artifactsDir, name));
  } catch {
    return { ok: false, reason: `the build did not write ${artifact}` };
  }
  await deps.journal.fact(OrchEvent.DeployVerified, { attempt, url: '', smoke: [], healthcheck: 'artifact', kind: 'mobile', artifact: name });
  return { ok: true, url: '', smoke: [], healthcheck: 'artifact' };
}
