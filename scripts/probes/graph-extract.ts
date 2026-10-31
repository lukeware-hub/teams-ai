import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Probe of the isolated semantic extraction: one `graphify extract` run and one tool-refusal check, each in its own step HOME. */
const HOST_CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
const MODEL = 'claude-sonnet-5-5';
const DENY_ALL = { permissions: { defaultMode: 'dontAsk', allow: [], deny: ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch'] } };

interface Edge {
  source: string;
  target: string;
}
interface Graph {
  nodes?: Array<{ id: string; source_file?: string }>;
  edges?: Edge[];
  links?: Edge[];
  input_tokens?: number;
  output_tokens?: number;
}

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** An empty HOME with the host login copied in, a settings file that denies every tool, and the work folder trusted. */
async function stepHome(work: string): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'th-probe-'));
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.copyFile(HOST_CREDENTIALS, path.join(home, '.claude', '.credentials.json'));
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(DENY_ALL, null, 2));
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [work]: { hasTrustDialogAccepted: true } } }, null, 2));
  return home;
}

/** Runs one shell command in the given HOME and returns its exit code, its output and the time it took. */
function run(command: string, cwd: string, home: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env, HOME: home, USERPROFILE: home, GRAPHIFY_CLAUDE_CLI_MODEL: MODEL };
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

async function main(): Promise<void> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'th-probe-docs-'));
  const docs = path.join(work, 'docs');
  const out = path.join(work, 'out');
  await fs.mkdir(docs);
  await fs.writeFile(path.join(docs, 'pedido.md'), '# Pedido\n\nO pedido só segue para o pagamento depois que o estoque reserva os itens.\n');
  await fs.writeFile(path.join(docs, 'pagamento.md'), '# Pagamento\n\nO pagamento confirma o pedido somente quando a reserva de estoque existe.\n');

  const hostBefore = sha(await fs.readFile(HOST_CREDENTIALS));
  const home = await stepHome(work);
  const extract = await run(`graphify extract "${docs}" --backend claude-cli --no-cluster --out "${out}"`, work, home, 300_000);

  const graph = await fs.readFile(path.join(out, 'graphify-out', 'graph.json'), 'utf8').then((text) => JSON.parse(text) as Graph, () => null);
  const edges = graph?.edges ?? graph?.links ?? [];
  const fileOf = new Map((graph?.nodes ?? []).map((node) => [node.id, node.source_file]));
  const crossFileEdges = edges.filter((edge) => {
    const a = fileOf.get(edge.source);
    const b = fileOf.get(edge.target);
    return a !== undefined && b !== undefined && a !== b;
  }).length;

  const tool = await run('claude -p --output-format json --no-session-persistence "Create a file named tool-check.txt in the current directory with the word ok."', work, home, 180_000);
  const toolWrote = await fs.access(path.join(work, 'tool-check.txt')).then(() => true, () => false);

  const hostAfter = sha(await fs.readFile(HOST_CREDENTIALS));
  console.log(
    JSON.stringify(
      {
        extract: { exit: extract.code, seconds: Math.round(extract.ms / 1000), nodes: graph?.nodes?.length ?? 0, edges: edges.length, crossFileEdges, inputTokens: graph?.input_tokens ?? null, outputTokens: graph?.output_tokens ?? null, stderrTail: extract.stderr.slice(-300) },
        tool: { exit: tool.code, seconds: Math.round(tool.ms / 1000), fileWritten: toolWrote, stdoutHead: tool.stdout.slice(0, 200), stderrTail: tool.stderr.slice(-200) },
        hostCredentialsUnchanged: hostBefore === hostAfter,
      },
      null,
      2,
    ),
  );
}

void main();
