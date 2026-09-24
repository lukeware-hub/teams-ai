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

/** Source extensions that count as code for the coverage denominator. */
export const CODE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.kt', '.rb', '.rs', '.cs', '.php', '.swift', '.scala', '.c', '.cc', '.cpp', '.h', '.hpp', '.sh', '.dart', '.ex', '.exs', '.lua', '.sql'];

export function isCodeFile(file: string): boolean {
  const lower = file.toLowerCase();
  return CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

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

export interface GraphifyDeps {
  exec: Exec;
  readFile: (absolutePath: string) => Promise<string | null>;
  /** Moves a directory (replacing the destination); defaults to fs.rename with a prior rm. */
  moveDir?: (from: string, to: string) => Promise<void>;
}

async function defaultMoveDir(from: string, to: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.rm(to, { recursive: true, force: true });
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}

/** Thin wrapper over the graphify CLI; no LLM-backed feature is ever invoked. */
export class Graphify {
  private readonly moveDir: (from: string, to: string) => Promise<void>;
  /** One update at a time per repository: graphify writes a fixed graphify-out/ path inside it. */
  private readonly updates = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: GraphifyDeps) {
    this.moveDir = deps.moveDir ?? defaultMoveDir;
  }

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

  /**
   * AST-only rebuild after a merge (spec §9 layer 2). graphify writes `graphify-out/` next to the
   * path it scans, so the run happens inside the repository and the output is moved to `outDir`;
   * the graph never lives in the repository (and Plan 6 excludes `graphify-out/` via .git/info/exclude).
   */
  update(repoDir: string, outDir: string): Promise<GraphCoverage> {
    const key = path.resolve(repoDir);
    const work = async () => {
      await this.run(['update', '.', '--no-cluster'], repoDir);
      const produced = path.join(repoDir, 'graphify-out');
      try {
        await this.moveDir(produced, path.join(outDir, 'graphify-out'));
      } catch {
        /* nothing produced (unsupported repo) → coverage 0 below */
      }
      return this.coverage(outDir, await this.trackedFiles(repoDir));
    };
    const previous = this.updates.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    this.updates.set(key, result.catch(() => undefined));
    return result;
  }

  /**
   * Coverage of the code graph. graphify's `extracted_sources`/`failed_sources` are only filled by
   * the LLM extractors; the AST mode we use leaves them empty (verified in WSL), so the measure is
   * the distinct code files present in the graph over the tracked code files of the repository
   * (`extracted` = covered files, `failed` = tracked code files absent from the graph).
   */
  async coverage(outDir: string, trackedFiles: readonly string[]): Promise<GraphCoverage> {
    const empty = { extracted: 0, failed: 0, nodes: 0, links: 0, ratio: 0 };
    const raw = await this.deps.readFile(this.graphPath(outDir));
    if (!raw) return empty;
    let g: { extracted_sources?: string[]; failed_sources?: string[]; nodes?: Array<{ source_file?: string }>; links?: unknown[] };
    try {
      g = JSON.parse(raw) as typeof g;
    } catch {
      return empty;
    }
    const nodes = g.nodes?.length ?? 0;
    const links = g.links?.length ?? 0;
    if ((g.extracted_sources?.length ?? 0) + (g.failed_sources?.length ?? 0) > 0) {
      const extracted = g.extracted_sources!.length;
      const failed = g.failed_sources?.length ?? 0;
      return { extracted, failed, nodes, links, ratio: extracted / (extracted + failed) };
    }
    const inGraph = new Set((g.nodes ?? []).map((n) => n.source_file).filter((f): f is string => !!f && isCodeFile(f)));
    const tracked = trackedFiles.filter(isCodeFile);
    const covered = tracked.filter((f) => inGraph.has(f)).length;
    return { extracted: covered, failed: tracked.length - covered, nodes, links, ratio: tracked.length === 0 ? 0 : covered / tracked.length };
  }

  /** Tracked files of the repository, for the coverage denominator. */
  async trackedFiles(repoDir: string): Promise<string[]> {
    try {
      const r = await this.deps.exec({ bin: 'git', args: ['ls-files'], cwd: repoDir, timeoutMs: 60_000 });
      return r.exitCode === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    } catch {
      return [];
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
  // -z terminates the path with NUL, so a ':' inside a file name cannot shift the fields.
  const args = ['grep', '-n', '-I', '-i', '-z'];
  for (const t of terms) args.push('-e', t);
  args.push('--', '.');
  const r = await exec({ bin: 'git', args, cwd: repoDir, timeoutMs: 60_000 });
  if (r.exitCode !== 0) return [];
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const line of r.stdout.split('\n')) {
    const nul = line.indexOf('\0');
    if (nul === -1) continue;
    const m = line.slice(nul + 1).match(/^(\d+):(.*)$/);
    if (m) hits.push({ file: line.slice(0, nul), line: Number(m[1]), text: m[2]! });
    if (hits.length >= (opts.maxHits ?? 40)) break;
  }
  return hits;
}
