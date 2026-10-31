import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Governor } from '../../server/budget/governor.js';
import type { CommandResult, CommandSpec } from '../../server/exec/command.js';
import { DocGraphError, docGraphContext, documentCounts, extractDocs } from '../../server/knowledge/doc-graph.js';

let root = '';
let dir = '';
let out = '';
let parent = '';
let host = '';
let hostEnv: NodeJS.ProcessEnv = {};
const calls: CommandSpec[] = [];
let seen: { settings: string; creds: string | null } = { settings: '', creds: null };
let failWith: CommandResult | null = null;

const result = (over: Partial<CommandResult> = {}): CommandResult => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false, ...over });

/** A graphify stand-in: records the isolation it runs under and writes the graph of two documents. */
async function fakeExec(spec: CommandSpec): Promise<CommandResult> {
  calls.push(spec);
  const home = spec.env!.HOME!;
  seen = {
    settings: await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'),
    creds: await fs.readFile(path.join(home, '.claude', '.credentials.json'), 'utf8').catch(() => null),
  };
  if (failWith) return failWith;
  const target = spec.args[spec.args.indexOf('--out') + 1]!;
  await fs.mkdir(path.join(target, 'graphify-out'), { recursive: true });
  await fs.writeFile(
    path.join(target, 'graphify-out', 'graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'pedido_estoque', source_file: 'docs/pedido.md' },
        { id: 'pagamento_reserva', source_file: 'docs/pagamento.md' },
      ],
      edges: [{ source: 'pedido_estoque', target: 'pagamento_reserva' }],
      input_tokens: 2500,
      output_tokens: 90,
    }),
  );
  return result();
}

const deps = () => ({ exec: fakeExec, hostEnv, governor: new Governor(1) });

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-doc-graph-'))).replace(/\\/g, '/');
  dir = `${root}/docs`;
  out = `${root}/out`;
  parent = `${root}/homes`;
  host = `${root}/host`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/pedido.md`, '# Pedido\n\nO pedido segue para o pagamento depois da reserva.\n');
  await fs.writeFile(`${dir}/pagamento.md`, '# Pagamento\n\nO pagamento confirma o pedido com a reserva.\n');
  await fs.mkdir(`${host}/.claude`, { recursive: true });
  await fs.writeFile(`${host}/.claude/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 10 * 24 * 3600 * 1000 } }));
  hostEnv = { HOME: host, USERPROFILE: host, PATH: process.env.PATH ?? '' };
  calls.length = 0;
  failWith = null;
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('document graph extraction', () => {
  it('extracts with the claude backend, the pinned model and a HOME of its own', async () => {
    await extractDocs(deps(), dir, out, parent);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.bin).toBe('graphify');
    expect(call.args).toEqual(['extract', dir, '--backend', 'claude-cli', '--no-cluster', '--out', out]);
    expect(call.env).toMatchObject({ GRAPHIFY_CLAUDE_CLI_MODEL: 'claude-sonnet-5-5', SSH_AUTH_SOCK: '', DOCKER_HOST: '' });
    expect(call.env!.HOME).not.toBe(host);
    expect(call.env!.HOME!.replace(/\\/g, '/').startsWith(parent)).toBe(true);
  });

  it('denies every tool in the HOME of the extraction, and gives it the host login as a copy', async () => {
    await extractDocs(deps(), dir, out, parent);
    expect(JSON.parse(seen.settings).permissions.deny).toEqual(expect.arrayContaining(['Bash', 'Write', 'Read']));
    expect(JSON.parse(seen.settings).permissions.defaultMode).toBe('dontAsk');
    expect(seen.creds).toBe(await fs.readFile(`${host}/.claude/.credentials.json`, 'utf8'));
  });

  it('removes its HOME when it is done, and leaves the host login as it was', async () => {
    const before = await fs.readFile(`${host}/.claude/.credentials.json`, 'utf8');
    await extractDocs(deps(), dir, out, parent);
    await expect(fs.access(calls[0]!.env!.HOME!)).rejects.toThrow();
    expect(await fs.readFile(`${host}/.claude/.credentials.json`, 'utf8')).toBe(before);
  });

  it('counts the nodes, links and tokens of one document in the graph it wrote', async () => {
    await extractDocs(deps(), dir, out, parent);
    await expect(documentCounts(out, 'pedido.md')).resolves.toEqual({ nodes: 1, links: 1, inputTokens: 2500, outputTokens: 90 });
    await expect(documentCounts(out, 'design.md')).resolves.toMatchObject({ nodes: 0, links: 0 });
  });

  it('only the extraction of this module runs a graph extraction on the server', async () => {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (full.endsWith('.ts')) {
          const text = await fs.readFile(full, 'utf8');
          if (text.includes("'extract'") || text.includes('claude-cli')) found.push(path.relative('.', full).replace(/\\/g, '/'));
        }
      }
    };
    await walk(path.resolve(__dirname, '../../server'));
    expect(found).toEqual(['server/knowledge/doc-graph.ts']);
  });

  it('the graph context for a question is the answer of the query, and nothing when the query finds no node', async () => {
    const found = { query: async () => ({ nodes: [{ label: 'pedido', file: 'pedido.md', line: 1 }], truncated: false, text: 'pedido -> estoque' }) };
    await expect(docGraphContext(found as never, out, 'pedido', 2000)).resolves.toBe('pedido -> estoque');
    const none = { query: async () => ({ nodes: [], truncated: false, text: '' }) };
    await expect(docGraphContext(none as never, out, 'pedido', 2000)).resolves.toBe('');
    const broken = { query: async () => Promise.reject(new Error('sem grafo')) };
    await expect(docGraphContext(broken as never, out, 'pedido', 2000)).resolves.toBe('');
  });

  it('a failed extraction is an owner error with the end of its stderr, and its HOME is still removed', async () => {
    failWith = result({ exitCode: 1, stderr: 'limite de uso atingido' });
    await expect(extractDocs(deps(), dir, out, parent)).rejects.toBeInstanceOf(DocGraphError);
    await expect(extractDocs(deps(), dir, out, parent)).rejects.toThrow(/limite de uso atingido/);
    expect(await fs.readdir(parent).catch(() => [])).toEqual([]);
  });
});
