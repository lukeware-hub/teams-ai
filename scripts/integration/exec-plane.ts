import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gate } from '../../server/contracts/plan.js';
import { DockerLocalTarget } from '../../server/deploy/docker-local.js';
import { KindTarget } from '../../server/deploy/kind.js';
import { httpGet, runDeployment, type DeploymentIntent } from '../../server/deploy/target.js';
import { execCommand } from '../../server/exec/command.js';
import { runGates } from '../../server/exec/gate-runner.js';

const app = path.resolve('test/fixtures/hello-app');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-exec-plane-'));
await fs.cp(app, work, { recursive: true });
await fs.mkdir(path.join(work, 'reports'), { recursive: true });

console.log('== gates in docker');
const gates = [
  Gate.parse({ name: 'install', command: 'npm install --no-audit --no-fund', blocking: true, network: 'egress' }),
  Gate.parse({ name: 'unit-test', command: 'npm test', blocking: true }),
];
const g = await runGates(
  gates,
  { worktree: work, image: 'node:22-bookworm', junitPath: 'reports/junit.xml', cpus: 2, memory: '1g', timeoutMs: 600_000, secrets: {} },
  { exec: execCommand, readFile: async (p) => fs.readFile(p, 'utf8').catch(() => null) },
);
for (const r of g.results) console.log(`  ${r.name}: passed=${r.passed} exit=${r.exitCode} failure=${r.failure} junit=${r.junit?.length ?? 'none'}`);

const intent: DeploymentIntent = {
  projectId: 'hello-app',
  image: 'hello-app',
  tag: `it-${Date.now()}`,
  port: 3000,
  healthcheckPath: '/health',
  manifests: ['deploy/k8s.yaml'],
  secretNames: [],
  contextDir: work,
};
const smoke = async (baseUrl: string) => {
  const r = await httpGet(`${baseUrl}/`, 5_000);
  return r && r.status === 200 ? { ok: true, detail: 'GET / 200' } : { ok: false, detail: `GET / ${r?.status ?? 'no response'}` };
};

console.log('== docker-local deploy');
const local = new DockerLocalTarget({ exec: execCommand, get: httpGet, secrets: {} });
console.log('  ', JSON.stringify(await runDeployment(local, intent, { smoke, baseUrl: local.baseUrl(intent) })));
await local.destroy(intent);

if (process.env.KIND_CLUSTER) {
  console.log(`== kind deploy (${process.env.KIND_CLUSTER})`);
  const kind = new KindTarget({ exec: execCommand, secrets: {}, cluster: process.env.KIND_CLUSTER, readFile: (p) => fs.readFile(p, 'utf8') });
  console.log('  ', JSON.stringify(await runDeployment(kind, intent, { smoke: async () => ({ ok: true, detail: 'in-cluster probe is the smoke' }), baseUrl: '' })));
  await kind.destroy(intent);
}
await fs.rm(work, { recursive: true, force: true });
