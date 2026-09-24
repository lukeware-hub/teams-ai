import path from 'node:path';
import type { Exec } from '../exec/command.js';

export interface GraphNode {
  label: string;
  file: string | null;
  line: number | null;
}

export interface AffectedNode extends GraphNode {
  relation: string;
}

export interface GraphCoverage {
  extracted: number;
  failed: number;
  nodes: number;
  links: number;
  ratio: number;
}

/** Below this share of extracted sources the code graph is too thin; the pack falls back to grep (spec §9). */
export const MIN_COVERAGE = 0.5;

const TIMEOUT = 300_000;

const NODE_LINE = /^NODE (.+?) \[src=(.*?) loc=(?:L(\d+))? ?community=.*\]$/;
const AFFECTED_LINE = /^- (.+?) \[([a-z_]+)\] (\S+?):L(\d+)$/;
const GOD_LINE = /^\s*\d+\. (.+?) - (\d+) edges$/;

export function parseQuery(text: string): { nodes: GraphNode[]; truncated: boolean } {
  const nodes: GraphNode[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(NODE_LINE);
    if (!m) continue;
    if (!m[2]) continue; // external refs (ref_zod) have no source
    nodes.push({ label: m[1]!, file: m[2]!, line: m[3] ? Number(m[3]) : null });
  }
  return { nodes, truncated: /\[!\] TRUNCATED/.test(text) };
}

export function parseAffected(text: string): AffectedNode[] {
  const out: AffectedNode[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(AFFECTED_LINE);
    if (m) out.push({ label: m[1]!, relation: m[2]!, file: m[3]!, line: Number(m[4]) });
  }
  return out;
}

export function parseGodNodes(text: string): Array<{ label: string; edges: number }> {
  const out: Array<{ label: string; edges: number }> = [];
  for (const line of text.split('\n')) {
    const m = line.match(GOD_LINE);
    if (m) out.push({ label: m[1]!, edges: Number(m[2]) });
  }
  return out;
}

/** Thin wrapper over the graphify CLI; no LLM-backed feature is ever invoked. */
export class Graphify {
  constructor(private readonly deps: { exec: Exec; readFile: (absolutePath: string) => Promise<string | null> }) {}

  private graphPath(outDir: string) {
    return path.posix.join(outDir.replace(/\\/g, '/'), 'graphify-out', 'graph.json');
  }

  private async run(args: string[], cwd?: string): Promise<string> {
    try {
      const r = await this.deps.exec({ bin: 'graphify', args, cwd, timeoutMs: TIMEOUT });
      return r.exitCode === 0 ? r.stdout : '';
    } catch {
      return '';
    }
  }

  /** AST-only rebuild after a merge (spec §9 layer 2); the graph lives outside the repository. */
  async update(repoDir: string, outDir: string): Promise<GraphCoverage> {
    await this.run(['update', repoDir, '--no-cluster'], outDir);
    return this.coverage(outDir);
  }

  async coverage(outDir: string): Promise<GraphCoverage> {
    const raw = await this.deps.readFile(this.graphPath(outDir));
    if (!raw) return { extracted: 0, failed: 0, nodes: 0, links: 0, ratio: 0 };
    try {
      const g = JSON.parse(raw) as { extracted_sources?: string[]; failed_sources?: string[]; nodes?: unknown[]; links?: unknown[] };
      const extracted = g.extracted_sources?.length ?? 0;
      const failed = g.failed_sources?.length ?? 0;
      const total = extracted + failed;
      return { extracted, failed, nodes: g.nodes?.length ?? 0, links: g.links?.length ?? 0, ratio: total === 0 ? 0 : extracted / total };
    } catch {
      return { extracted: 0, failed: 0, nodes: 0, links: 0, ratio: 0 };
    }
  }

  async query(outDir: string, question: string, budgetTokens: number): Promise<{ nodes: GraphNode[]; truncated: boolean; text: string }> {
    const text = await this.run(['query', question, '--budget', String(budgetTokens), '--graph', this.graphPath(outDir)]);
    return { ...parseQuery(text), text };
  }

  async affected(outDir: string, symbol: string, depth: number): Promise<AffectedNode[]> {
    return parseAffected(await this.run(['affected', symbol, '--depth', String(depth), '--graph', this.graphPath(outDir)]));
  }

  async godNodes(outDir: string, top: number): Promise<Array<{ label: string; edges: number }>> {
    return parseGodNodes(await this.run(['god-nodes', '--top', String(top), '--graph', this.graphPath(outDir)]));
  }
}

/** When the graph is thin (unsupported language), tracked-file grep gives the Dev a starting point. */
export async function grepFallback(
  repoDir: string,
  terms: readonly string[],
  exec: Exec,
  opts: { maxHits?: number } = {},
): Promise<Array<{ file: string; line: number; text: string }>> {
  const args = ['grep', '-n', '-I', '-i'];
  for (const t of terms) args.push('-e', t);
  args.push('--', '.');
  const r = await exec({ bin: 'git', args, cwd: repoDir, timeoutMs: 60_000 });
  if (r.exitCode !== 0) return [];
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (m) hits.push({ file: m[1]!, line: Number(m[2]), text: m[3]! });
    if (hits.length >= (opts.maxHits ?? 40)) break;
  }
  return hits;
}
