import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Governor } from '../budget/governor.js';
import { MODELS } from '../config/config.js';
import type { CommandResult, Exec } from '../exec/command.js';
import { createStepHome, removeStepHome, syncBackCredentials } from '../runner/step-home.js';
import { withRefreshGate } from '../runner/step.js';
import type { Graphify } from './graphify.js';

/** The longest one extraction may run, the same bound as the other graph commands. */
const TIMEOUT_MS = 300_000;
/** Margin for the refresh gate, as a step uses it. */
const REFRESH_WINDOW_MS = 5 * 60_000;

/** Every tool is denied: graphify's own claude call passes no tool restrictions, so the settings of its HOME must. */
const DENY_ALL = { permissions: { defaultMode: 'dontAsk', allow: [], deny: ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch'] } };

/** Variables the orchestrator would pass on from its own environment: blanked so the extraction sees none of them. */
const BLANKED = { SSH_AUTH_SOCK: '', DOCKER_HOST: '', DOCKER_CONTEXT: '', DOCKER_CONFIG: '', KUBECONFIG: '' };

export interface DocGraphDeps {
  exec: Exec;
  hostEnv: NodeJS.ProcessEnv;
  governor: Governor;
  clock?: () => Date;
}

/** The nodes and links one document has in a graph, with the tokens the extraction booked. */
export interface DocGraphCount {
  nodes: number;
  links: number;
  inputTokens: number;
  outputTokens: number;
}

interface GraphFile {
  nodes?: Array<{ id: string; source_file?: string }>;
  edges?: Array<{ source: string; target: string }>;
  links?: Array<{ source: string; target: string }>;
  input_tokens?: number;
  output_tokens?: number;
}

export class DocGraphError extends Error {}

/** Writes the HOME of the extraction: the deny-all settings and a trust entry for the folder it reads. */
async function writeIsolation(home: string, dir: string): Promise<void> {
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(DENY_ALL, null, 2));
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [dir]: { hasTrustDialogAccepted: true } } }, null, 2));
}

/** The start and the end of a long stderr: the first failure is often at the start, the refusal at the end. */
const ends = (text: string): string => (text.length <= 800 ? text : `${text.slice(0, 400)} … ${text.slice(-400)}`);

/** Extracts the documents of `dir` into `outDir`, in a HOME of its own and with every tool denied. */
export async function extractDocs(deps: DocGraphDeps, dir: string, outDir: string, parentDir: string): Promise<void> {
  const home = await createStepHome(parentDir, deps.hostEnv);
  try {
    await writeIsolation(home, dir);
    const release = await deps.governor.acquire();
    let result: CommandResult;
    try {
      result = await withRefreshGate(deps.hostEnv, deps.clock ?? (() => new Date()), TIMEOUT_MS + REFRESH_WINDOW_MS, () =>
        deps.exec({
          bin: 'graphify',
          args: ['extract', dir, '--backend', 'claude-cli', '--no-cluster', '--out', outDir],
          cwd: dir,
          timeoutMs: TIMEOUT_MS,
          env: { ...BLANKED, HOME: home, USERPROFILE: home, GRAPHIFY_CLAUDE_CLI_MODEL: MODELS.sonnet },
        }),
      );
    } finally {
      release();
    }
    if (result.exitCode !== 0 || result.timedOut) throw new DocGraphError(`A extração dos documentos falhou: ${ends(result.stderr)}`);
  } finally {
    await syncBackCredentials(home, deps.hostEnv);
    await removeStepHome(home);
  }
}

/** The part of the graph that answers a question, for the packs; empty when the graph is missing or finds nothing, and the documents then travel in full. */
export async function docGraphContext(graphify: Pick<Graphify, 'query'>, outDir: string, question: string, budgetTokens: number): Promise<string> {
  const found = await graphify.query(outDir, question, budgetTokens).catch(() => null);
  return found && found.nodes.length > 0 ? found.text : '';
}

/** The nodes, links and tokens of one document in the graph an extraction wrote to `outDir`. */
export async function documentCounts(outDir: string, file: string): Promise<DocGraphCount> {
  const graph = JSON.parse(await fs.readFile(path.join(outDir, 'graphify-out', 'graph.json'), 'utf8')) as GraphFile;
  const nodes = (graph.nodes ?? []).filter((node) => path.basename(node.source_file ?? '') === file);
  const ids = new Set(nodes.map((node) => node.id));
  const links = (graph.edges ?? graph.links ?? []).filter((edge) => ids.has(edge.source) || ids.has(edge.target)).length;
  return { nodes: nodes.length, links, inputTokens: graph.input_tokens ?? 0, outputTokens: graph.output_tokens ?? 0 };
}
