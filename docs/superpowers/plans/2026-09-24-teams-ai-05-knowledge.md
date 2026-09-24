# teams-ai Plan 5 — Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three knowledge layers of spec §9 and the context-pack builder of §8.3/§9A.1: lookup by ID from the JSON contract, a code graph through graphify, and BM25 text retrieval over documentation and refinement history — assembled into a small, deterministic, budgeted prompt for every agent step.

**Architecture:** Pure modules plus two thin wrappers. `retrieval.ts` wraps `node:sqlite` FTS5 (built into Node 22, no dependency). `graphify.ts` builds CLI arguments and parses the CLI's text output; it never calls the LLM-backed graphify features. `context-pack.ts` is pure: given the contract slices, code context and retrieval hits, it renders sections in a fixed order (stable prefix first for prompt caching), enforces a token budget by priority, and states the output contract. Plan 6 wires these into the phases.

**Tech Stack:** Node 22 (ESM) with `node:sqlite` (FTS5, SQLite 3.51), TypeScript 5.9.3, Vitest 5, zod 4. graphify 0.9.67 CLI inside WSL. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` — §3.2 (knowledge unit), §8.3 (lean context), §9 (knowledge layers), §9A.1 (handoff), §9A.2 (references), §15A. **Findings:** graphify probe recorded in Task 5 of this plan.

## Global Constraints

- Everything from Plan 1's Global Constraints (pins, ESM, `.js` import suffix, English, commit trailer).
- No LLM calls: graphify runs with `--no-cluster` / `--no-label`; retrieval is BM25 only (embeddings only if BM25 is shown to miss, spec §9).
- `node:sqlite` prints an `ExperimentalWarning` on first use; tests tolerate it, production suppresses it with `process.removeAllListeners('warning')`-free means: run node with `--no-warnings=ExperimentalWarning` in the orchestrator entrypoint (Plan 6).
- Context packs are deterministic: same inputs → byte-identical output (no timestamps, no random ordering).
- Token estimate is `Math.ceil(chars / 4)`; the pack never exceeds `budgetTokens`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## Review Focus

1. **A query containing FTS5 syntax characters** (`"`, `*`, `-`, `NEAR`, a stray `(`) — retrieval must not throw `fts5: syntax error`; it must sanitize into a plain bag of terms (test in Task 1).
2. **A document changed and re-indexed** — the old chunks must disappear, never rank alongside the new ones (test in Task 1).
3. **graphify output with zero extracted sources or `graph.json` missing** — the wrapper must report coverage 0 and the pack must fall back to grep, never crash a step (tests in Tasks 2 and 3).
4. **Over-budget input** — the pack must drop the lowest-priority sections whole and say what was dropped; principles, contract and the task itself are never dropped (test in Task 3).
5. **Handoff summaries of many dependencies** — capped per dependency and overall, with the newest merged first, so a task with 10 dependencies still fits (test in Task 3).

---

## File structure

```
server/knowledge/chunker.ts       heading-aware chunking with stable chunk ids
server/knowledge/retrieval.ts     KnowledgeIndex (node:sqlite FTS5): index/replace/search/removeDocument
server/knowledge/graphify.ts      graphify CLI wrapper: update/query/affected/godNodes/coverage + grepFallback
server/knowledge/context-pack.ts  buildContextPack(): sections, budget, output contract statement
test/knowledge/*.test.ts
test/fixtures/graphify/*.txt      recorded graphify outputs (from the WSL probe)
scripts/integration/knowledge.ts  manual: graphify on a real repo + retrieval over docs/ (Task 5)
```

---

### Task 1: Chunker and FTS5 retrieval

**Files:**
- Create: `server/knowledge/chunker.ts`, `server/knowledge/retrieval.ts`
- Test: `test/knowledge/retrieval.test.ts`

**Interfaces:**
- `chunker.ts`:
  - `interface Chunk { id: string; docId: string; ordinal: number; heading: string | null; text: string }`
  - `chunkMarkdown(docId: string, text: string, opts?: { maxChars?: number }): Chunk[]` — splits at `#` headings, then at blank lines when a section exceeds `maxChars` (default 1200); `id = <docId>#<ordinal>`; whitespace-only chunks dropped
- `retrieval.ts`:
  - `type DocKind = 'spec' | 'adr' | 'tech-spec' | 'qa' | 'principles' | 'report' | 'other'`
  - `interface KnowledgeDoc { id: string; kind: DocKind; title: string; text: string; specId?: string }`
  - `interface Hit { chunkId: string; docId: string; kind: DocKind; title: string; heading: string | null; snippet: string; text: string; score: number }`
  - `class KnowledgeIndex { static open(file: string | ':memory:'): KnowledgeIndex; index(doc: KnowledgeDoc): number; removeDocument(id: string): void; search(query: string, opts?: { k?: number; kinds?: DocKind[]; specId?: string }): Hit[]; count(): number; close(): void }`
  - `sanitizeQuery(query: string): string` — keeps `[\p{L}\p{N}_-]+` terms, drops FTS5 operators, joins with spaces (implicit AND), returns `''` when nothing remains (search then returns `[]`)

- [ ] **Step 1: Write the failing test**

`test/knowledge/retrieval.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../../server/knowledge/chunker.js';
import { KnowledgeIndex, sanitizeQuery, type KnowledgeDoc } from '../../server/knowledge/retrieval.js';

const SPEC1 = `# Spec 1: discounts
## Objectives
Customers with the VIP tier receive a discount.
## Decisions
The maximum discount is 5 percent, decided by the PO on 2026-09-10.
`;
const ADR2 = `# ADR-002: Authentication
We use JWT bearer tokens. Sessions are stateless.
`;

describe('chunkMarkdown', () => {
  it('splits at headings with stable ids and keeps the heading text', () => {
    const chunks = chunkMarkdown('spec-001', SPEC1);
    // The title heading has no body of its own and is skipped.
    expect(chunks.map((c) => c.id)).toEqual(['spec-001#0', 'spec-001#1']);
    expect(chunks[0]).toMatchObject({ heading: 'Objectives', ordinal: 0 });
    expect(chunks[1]!.text).toContain('5 percent');
  });

  it('splits long sections at blank lines and drops empty pieces', () => {
    const long = `# T\n\n${'para one '.repeat(50)}\n\n${'para two '.repeat(50)}\n\n\n`;
    const chunks = chunkMarkdown('d', long, { maxChars: 300 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.text.trim().length).toBeGreaterThan(0);
  });
});

describe('sanitizeQuery', () => {
  it('strips FTS5 operators and punctuation, keeps terms', () => {
    expect(sanitizeQuery('discount "VIP" NEAR(x) -5% (max*)')).toBe('discount VIP NEAR x 5 max');
    expect(sanitizeQuery('"""')).toBe('');
    expect(sanitizeQuery('não-conformidade ação')).toBe('não-conformidade ação');
  });
});

describe('KnowledgeIndex', () => {
  let idx: KnowledgeIndex;
  const spec: KnowledgeDoc = { id: 'spec-001', kind: 'spec', title: 'Spec 1', text: SPEC1, specId: 'spec-001' };
  const adr: KnowledgeDoc = { id: 'ADR-002', kind: 'adr', title: 'ADR-002', text: ADR2 };

  beforeEach(() => {
    idx = KnowledgeIndex.open(':memory:');
    idx.index(spec);
    idx.index(adr);
  });
  afterEach(() => idx.close());

  it('ranks the chunk about the topic first and returns a snippet', () => {
    const hits = idx.search('maximum discount percent decided');
    expect(hits[0]).toMatchObject({ docId: 'spec-001', kind: 'spec', heading: 'Decisions' });
    expect(hits[0]!.snippet).toMatch(/discount/i);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('filters by kind and by specId', () => {
    expect(idx.search('tokens sessions', { kinds: ['adr'] })[0]!.docId).toBe('ADR-002');
    expect(idx.search('tokens sessions', { kinds: ['spec'] })).toEqual([]);
    expect(idx.search('discount', { specId: 'spec-001' })).not.toEqual([]);
    expect(idx.search('discount', { specId: 'spec-999' })).toEqual([]);
  });

  it('never throws on FTS5 syntax in the query and returns nothing for an empty bag', () => {
    expect(() => idx.search('"unterminated NEAR( -x')).not.toThrow();
    expect(idx.search('"""')).toEqual([]);
  });

  it('replaces a re-indexed document instead of duplicating it', () => {
    idx.index({ ...spec, text: '# Spec 1\n## Decisions\nThe maximum discount is 10 percent now.\n' });
    const hits = idx.search('maximum discount percent');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain('10 percent');
    expect(idx.count()).toBe(2); // spec chunk + adr chunk
  });

  it('removes a document', () => {
    idx.removeDocument('ADR-002');
    expect(idx.search('JWT')).toEqual([]);
  });

  it('respects k', () => {
    for (let i = 0; i < 5; i++) idx.index({ id: `qa-${i}`, kind: 'qa', title: `Q${i}`, text: `Question ${i}: what discount applies? Answer: discount ${i}.` });
    expect(idx.search('discount', { k: 3 })).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/knowledge/retrieval.test.ts`
Expected: FAIL — cannot resolve `../../server/knowledge/chunker.js`.

- [ ] **Step 3: Write the chunker**

`server/knowledge/chunker.ts`:
```ts
export interface Chunk {
  id: string;
  docId: string;
  ordinal: number;
  heading: string | null;
  text: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/** Heading-aware chunking: one chunk per section, long sections split at blank lines. Ids are stable for a given text. */
export function chunkMarkdown(docId: string, text: string, opts: { maxChars?: number } = {}): Chunk[] {
  const max = opts.maxChars ?? 1200;
  const sections: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(HEADING);
    if (m) sections.push({ heading: m[2]!.trim(), lines: [line] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  const pieces: Array<{ heading: string | null; text: string }> = [];
  for (const s of sections) {
    const body = s.lines.join('\n').trim();
    if (body === '') continue;
    // A heading with no body carries no information; skip it so it never ranks as a hit.
    if (s.heading !== null && s.lines.slice(1).join('\n').trim() === '') continue;
    if (body.length <= max) {
      pieces.push({ heading: s.heading, text: body });
      continue;
    }
    let current = '';
    for (const para of body.split(/\n\s*\n/)) {
      const candidate = current === '' ? para : `${current}\n\n${para}`;
      if (candidate.length > max && current !== '') {
        pieces.push({ heading: s.heading, text: current.trim() });
        current = para;
      } else {
        current = candidate;
      }
    }
    if (current.trim() !== '') pieces.push({ heading: s.heading, text: current.trim() });
  }
  return pieces.map((p, ordinal) => ({ id: `${docId}#${ordinal}`, docId, ordinal, heading: p.heading, text: p.text }));
}
```

- [ ] **Step 4: Write the index**

`server/knowledge/retrieval.ts`:
```ts
import { DatabaseSync } from 'node:sqlite';
import { chunkMarkdown } from './chunker.js';

export type DocKind = 'spec' | 'adr' | 'tech-spec' | 'qa' | 'principles' | 'report' | 'other';

export interface KnowledgeDoc {
  id: string;
  kind: DocKind;
  title: string;
  text: string;
  specId?: string;
}

export interface Hit {
  chunkId: string;
  docId: string;
  kind: DocKind;
  title: string;
  heading: string | null;
  snippet: string;
  text: string;
  score: number;
}

/** FTS5 has its own query language; agent and human text is a bag of terms, nothing more. */
export function sanitizeQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.filter((t) => t !== '-' && t !== '_').map((t) => t.replace(/^-+|-+$/g, '')).filter(Boolean).join(' ');
}

/**
 * BM25 retrieval over documentation and refinement history (spec §9 layer 3). Requirements and
 * criteria are never looked up here — they are addressed by ID from the contract.
 */
export class KnowledgeIndex {
  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string | ':memory:'): KnowledgeIndex {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, spec_id TEXT);
      CREATE TABLE IF NOT EXISTS chunks (chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, heading TEXT, text TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(heading, text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.rowid, new.heading, new.text); END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, heading, text) VALUES ('delete', old.rowid, old.heading, old.text); END;
      PRAGMA foreign_keys = ON;
    `);
    return new KnowledgeIndex(db);
  }

  /** Indexes or replaces a document; returns the number of chunks stored. */
  index(doc: KnowledgeDoc): number {
    const chunks = chunkMarkdown(doc.id, doc.text);
    const tx = this.db.prepare('BEGIN');
    tx.run();
    try {
      this.removeDocument(doc.id);
      this.db.prepare('INSERT INTO docs(id, kind, title, spec_id) VALUES (?, ?, ?, ?)').run(doc.id, doc.kind, doc.title, doc.specId ?? null);
      const insert = this.db.prepare('INSERT INTO chunks(chunk_id, doc_id, ordinal, heading, text) VALUES (?, ?, ?, ?, ?)');
      for (const c of chunks) insert.run(c.id, c.docId, c.ordinal, c.heading, c.text);
      this.db.prepare('COMMIT').run();
    } catch (err) {
      this.db.prepare('ROLLBACK').run();
      throw err;
    }
    return chunks.length;
  }

  removeDocument(id: string): void {
    this.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(id);
    this.db.prepare('DELETE FROM docs WHERE id = ?').run(id);
  }

  search(query: string, opts: { k?: number; kinds?: DocKind[]; specId?: string } = {}): Hit[] {
    const bag = sanitizeQuery(query);
    if (bag === '') return [];
    // OR semantics: the caller passes a bag of terms; BM25 ranks chunks that match more of them higher.
    const q = bag.split(' ').map((t) => `"${t.replaceAll('"', '')}"`).join(' OR ');
    const k = opts.k ?? 8;
    const where: string[] = ['chunks_fts MATCH ?'];
    const params: Array<string | number> = [q];
    if (opts.kinds && opts.kinds.length > 0) {
      where.push(`d.kind IN (${opts.kinds.map(() => '?').join(',')})`);
      params.push(...opts.kinds);
    }
    if (opts.specId) {
      where.push('(d.spec_id = ? OR d.spec_id IS NULL)');
      params.push(opts.specId);
    }
    params.push(k);
    const rows = this.db
      .prepare(
        `SELECT c.chunk_id, c.doc_id, d.kind, d.title, c.heading, c.text,
                snippet(chunks_fts, 1, '[', ']', '…', 12) AS snippet,
                -bm25(chunks_fts) AS score
         FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid JOIN docs d ON d.id = c.doc_id
         WHERE ${where.join(' AND ')}
         ORDER BY bm25(chunks_fts) LIMIT ?`,
      )
      .all(...params) as Array<{ chunk_id: string; doc_id: string; kind: DocKind; title: string; heading: string | null; text: string; snippet: string; score: number }>;
    return rows.map((r) => ({ chunkId: r.chunk_id, docId: r.doc_id, kind: r.kind, title: r.title, heading: r.heading, snippet: r.snippet, text: r.text, score: r.score }));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/knowledge/retrieval.test.ts && npm run typecheck`
Expected: 10 tests PASS; typecheck exits 0. (An `ExperimentalWarning: SQLite` line on stderr is expected.) If `snippet()` returns an empty string for the top hit because the match is in the `heading` column, change the snippet column index from `1` to `-1` (all columns) and keep the assertion.

- [ ] **Step 6: Commit**

```bash
git add server/knowledge/chunker.ts server/knowledge/retrieval.ts test/knowledge/retrieval.test.ts
git commit -m "feat: add heading-aware chunker and FTS5 knowledge index" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: graphify wrapper and grep fallback

**Files:**
- Create: `server/knowledge/graphify.ts`
- Create: `test/fixtures/graphify/query.txt`, `test/fixtures/graphify/affected.txt`, `test/fixtures/graphify/god-nodes.txt`, `test/fixtures/graphify/graph.json`
- Test: `test/knowledge/graphify.test.ts`

**Interfaces:**
- Consumes: `Exec` (Plan 4 Task 1).
- Produces:
  - `interface GraphNode { label: string; file: string | null; line: number | null }`
  - `interface AffectedNode extends GraphNode { relation: string }`
  - `interface GraphCoverage { extracted: number; failed: number; nodes: number; links: number; ratio: number }` — `ratio = extracted / (extracted + failed)`, 0 when nothing extracted
  - `class Graphify { constructor(deps: { exec: Exec; readFile: (p: string) => Promise<string | null> }); update(repoDir: string, outDir: string): Promise<GraphCoverage>; query(outDir: string, question: string, budgetTokens: number): Promise<{ nodes: GraphNode[]; truncated: boolean; text: string }>; affected(outDir: string, symbol: string, depth: number): Promise<AffectedNode[]>; godNodes(outDir: string, top: number): Promise<Array<{ label: string; edges: number }>>; coverage(outDir: string): Promise<GraphCoverage> }`
  - `parseQuery(text: string)`, `parseAffected(text: string)`, `parseGodNodes(text: string)` — pure, exported for tests
  - `grepFallback(repoDir: string, terms: readonly string[], exec: Exec, opts?: { maxHits?: number }): Promise<Array<{ file: string; line: number; text: string }>>` — `git grep -n -I -i -e <t> [-e <t>...]` restricted to tracked files
  - `MIN_COVERAGE = 0.5` — below this the context pack uses grep instead of the graph (spec §9 fallback)

The `outDir` is outside the repository (`workspaces/<p>/graph/`, spec §9); graphify writes `graphify-out/` inside the directory it is run in, so `update` runs with `cwd = outDir` on a path argument pointing at the repo and passes `--graph` explicitly to the read commands.

- [ ] **Step 1: Write the fixtures (recorded from graphify 0.9.67 on this repository)**

`test/fixtures/graphify/query.txt`:
```
Graph: graphify-out/graph.json (412 nodes) | Traversal: BFS depth=2 | Start: ['stream-events.ts', 'StreamEvent'] | 128 nodes found

[!] TRUNCATED: showing 4 of 128 nodes (~400-token budget). The answer may be among the 124 cut nodes — raise the token budget (CLI: --budget) or narrow the query (e.g. context_filter=['call'], or get_node for a specific symbol).

NODE stream-events.ts [src=server/runner/stream-events.ts loc=L1 community=]
NODE StreamEvent [src=server/runner/stream-events.ts loc=L3 community=]
NODE ref_zod [src= loc= community=]
NODE RateLimitInfo [src=server/runner/stream-events.ts loc=L63 community=]
```

`test/fixtures/graphify/affected.txt`:
```
Affected nodes for summarizeStream()
Relations: calls, indirect_call, references, imports, imports_from, dynamic_import, re_exports, inherits, extends, implements, uses, mixes_in, embeds, requires
Depth: 1
- process-runner.ts [imports] server/runner/process-runner.ts:L6
- runProcess() [calls] server/runner/process-runner.ts:L130
```

`test/fixtures/graphify/god-nodes.txt`:
```
God nodes (most connected):
  1. DeploymentIntent - 23 edges
  2. DockerLocalTarget - 14 edges
  3. git() - 13 edges
```

`test/fixtures/graphify/graph.json`:
```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "failed_sources": ["server/legacy/old.cob"],
  "extracted_sources": ["server/runner/stream-events.ts", "server/runner/step.ts", "server/deploy/kind.ts"],
  "nodes": [
    { "id": "server_runner_stream_events", "label": "stream-events.ts", "file_type": "code", "source_file": "server/runner/stream-events.ts", "source_location": "L1", "_origin": "ast" },
    { "id": "server_runner_step_runstep", "label": "runStep()", "file_type": "code", "source_file": "server/runner/step.ts", "source_location": "L100", "_origin": "ast" }
  ],
  "links": [{ "source": "server_runner_step_runstep", "target": "server_runner_stream_events", "relation": "imports" }],
  "directed": false
}
```

- [ ] **Step 2: Write the failing test**

`test/knowledge/graphify.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Graphify, MIN_COVERAGE, grepFallback, parseAffected, parseGodNodes, parseQuery } from '../../server/knowledge/graphify.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const fx = (name: string) => readFileSync(path.resolve(`test/fixtures/graphify/${name}`), 'utf8');

describe('parsers', () => {
  it('parses query nodes, keeps the truncation flag and drops nodes without a source', () => {
    const r = parseQuery(fx('query.txt'));
    expect(r.truncated).toBe(true);
    expect(r.nodes).toEqual([
      { label: 'stream-events.ts', file: 'server/runner/stream-events.ts', line: 1 },
      { label: 'StreamEvent', file: 'server/runner/stream-events.ts', line: 3 },
      { label: 'RateLimitInfo', file: 'server/runner/stream-events.ts', line: 63 },
    ]);
  });

  it('parses affected nodes with their relation', () => {
    expect(parseAffected(fx('affected.txt'))).toEqual([
      { label: 'process-runner.ts', relation: 'imports', file: 'server/runner/process-runner.ts', line: 6 },
      { label: 'runProcess()', relation: 'calls', file: 'server/runner/process-runner.ts', line: 130 },
    ]);
  });

  it('parses god nodes', () => {
    expect(parseGodNodes(fx('god-nodes.txt'))).toEqual([
      { label: 'DeploymentIntent', edges: 23 },
      { label: 'DockerLocalTarget', edges: 14 },
      { label: 'git()', edges: 13 },
    ]);
  });

  it('returns empty results for unexpected text', () => {
    expect(parseQuery('graphify: error: no graph found')).toEqual({ nodes: [], truncated: false });
    expect(parseAffected('')).toEqual([]);
    expect(parseGodNodes('nothing')).toEqual([]);
  });
});

describe('Graphify', () => {
  const files = (map: Record<string, string>) => async (p: string) => map[p.replace(/\\/g, '/')] ?? null;

  it('runs update without LLM features and reports coverage from graph.json', async () => {
    const fake = new FakeExec();
    const g = new Graphify({ exec: fake.exec, readFile: files({ '/ws/graph/graphify-out/graph.json': fx('graph.json') }) });
    const cov = await g.update('/ws/repo', '/ws/graph');
    expect(fake.calls[0]).toMatchObject({ bin: 'graphify', args: ['update', '/ws/repo', '--no-cluster'], cwd: '/ws/graph' });
    expect(cov).toEqual({ extracted: 3, failed: 1, nodes: 2, links: 1, ratio: 0.75 });
  });

  it('reports zero coverage when graph.json is missing or has no sources', async () => {
    const g = new Graphify({ exec: new FakeExec().exec, readFile: files({}) });
    expect(await g.coverage('/ws/graph')).toEqual({ extracted: 0, failed: 0, nodes: 0, links: 0, ratio: 0 });
    const empty = new Graphify({ exec: new FakeExec().exec, readFile: files({ '/ws/graph/graphify-out/graph.json': '{"nodes":[],"links":[],"extracted_sources":[],"failed_sources":[]}' }) });
    expect((await empty.coverage('/ws/graph')).ratio).toBe(0);
    expect(MIN_COVERAGE).toBe(0.5);
  });

  it('passes --graph and the budget to query, depth to affected, top to god-nodes', async () => {
    const fake = new FakeExec()
      .onArgs('graphify', ['query'], () => ({ stdout: fx('query.txt') }))
      .onArgs('graphify', ['affected'], () => ({ stdout: fx('affected.txt') }))
      .onArgs('graphify', ['god-nodes'], () => ({ stdout: fx('god-nodes.txt') }));
    const g = new Graphify({ exec: fake.exec, readFile: files({}) });
    const q = await g.query('/ws/graph', 'how are results summarized', 400);
    expect(q.nodes).toHaveLength(3);
    expect(q.truncated).toBe(true);
    expect(fake.lines('graphify')[0]).toBe('query how are results summarized --budget 400 --graph /ws/graph/graphify-out/graph.json');
    expect((await g.affected('/ws/graph', 'summarizeStream', 2))[1]!.relation).toBe('calls');
    expect(fake.lines('graphify')[1]).toBe('affected summarizeStream --depth 2 --graph /ws/graph/graphify-out/graph.json');
    expect(await g.godNodes('/ws/graph', 3)).toHaveLength(3);
  });

  it('returns empty results instead of throwing when graphify fails', async () => {
    const fake = new FakeExec().on((s) => s.bin === 'graphify', () => ({ exitCode: 1, stderr: 'no graph' }));
    const g = new Graphify({ exec: fake.exec, readFile: files({}) });
    expect(await g.query('/ws/graph', 'x', 100)).toEqual({ nodes: [], truncated: false, text: '' });
    expect(await g.affected('/ws/graph', 'x', 1)).toEqual([]);
  });
});

describe('grepFallback', () => {
  it('searches tracked files case-insensitively and parses file:line:text', async () => {
    const fake = new FakeExec().onArgs('git', ['grep'], () => ({ stdout: 'src/a.ts:12:const discount = 5;\nsrc/b.ts:3:// Discount rules\n' }));
    const hits = await grepFallback('/ws/repo', ['discount', 'vip'], fake.exec);
    expect(hits).toEqual([
      { file: 'src/a.ts', line: 12, text: 'const discount = 5;' },
      { file: 'src/b.ts', line: 3, text: '// Discount rules' },
    ]);
    expect(fake.calls[0]).toMatchObject({ bin: 'git', cwd: '/ws/repo', args: ['grep', '-n', '-I', '-i', '-e', 'discount', '-e', 'vip', '--', '.'] });
  });

  it('caps hits and tolerates exit code 1 (no match)', async () => {
    const fake = new FakeExec().onArgs('git', ['grep'], () => ({ exitCode: 1 }));
    expect(await grepFallback('/ws/repo', ['zzz'], fake.exec)).toEqual([]);
    const many = new FakeExec().onArgs('git', ['grep'], () => ({ stdout: Array.from({ length: 50 }, (_, i) => `f.ts:${i + 1}:x`).join('\n') }));
    expect(await grepFallback('/ws/repo', ['x'], many.exec, { maxHits: 5 })).toHaveLength(5);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/knowledge/graphify.test.ts`
Expected: FAIL — cannot resolve `../../server/knowledge/graphify.js`.

- [ ] **Step 4: Write the wrapper**

`server/knowledge/graphify.ts`:
```ts
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
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/knowledge/graphify.test.ts && npm run typecheck`
Expected: 10 tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/knowledge/graphify.ts test/fixtures/graphify test/knowledge/graphify.test.ts
git commit -m "feat: add graphify CLI wrapper with coverage and grep fallback" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Context pack builder

**Files:**
- Create: `server/knowledge/context-pack.ts`
- Test: `test/knowledge/context-pack.test.ts`

**Interfaces:**
- Consumes: `Spec`, `AcceptanceCriterion` (Plan 1), `PlanTask` (Plan 1), `StepKind` (Plan 3 Task 3), `Hit` (Task 1), `GraphNode`, `AffectedNode` (Task 2).
- Produces:
  - `interface HandoffSummary { taskId: string; title: string; summary: string; changedFiles: string[]; mergedAt: string }`
  - `interface CodeContext { source: 'graph' | 'grep' | 'none'; nodes?: GraphNode[]; affected?: AffectedNode[]; grep?: Array<{ file: string; line: number; text: string }>; truncated?: boolean }`
  - `interface ContextPackInput { kind: StepKind; role: string; specHash: string; principles: readonly string[]; outputContract: string; task?: PlanTask; criteria: readonly AcceptanceCriterion[]; objectives?: readonly string[]; techSpecExcerpt?: string; adrs?: ReadonlyArray<{ id: string; title: string; text: string }>; assumptions?: readonly string[]; handoffs?: readonly HandoffSummary[]; code?: CodeContext; retrieval?: readonly Hit[]; feedback?: string; budgetTokens: number }`
  - `interface ContextPack { text: string; tokens: number; sections: string[]; dropped: string[] }`
  - `estimateTokens(text: string): number` — `Math.ceil(text.length / 4)`
  - `buildContextPack(input: ContextPackInput): ContextPack`
  - `SECTION_ORDER` and `NEVER_DROP` (`['principles', 'contract', 'task', 'criteria']`)

Section order (stable prefix first, spec §8.3): `principles` → `contract` (specHash + output contract) → `task` → `criteria` → `objectives` → `tech-spec` → `adrs` → `assumptions` → `handoffs` → `code` → `retrieval` → `feedback`. When over budget, sections are dropped whole from the end of a drop list (`retrieval`, `code`, `adrs`, `tech-spec`, `objectives`, `handoffs`, `assumptions`, `feedback` — feedback is dropped last because a retry needs it) until the pack fits; `NEVER_DROP` sections are always kept even if the pack then exceeds the budget, and that is reported via `dropped` containing `'!over-budget'`. Handoffs: newest first, each summary cut at 400 chars, at most 6 dependencies.

- [ ] **Step 1: Write the failing test**

`test/knowledge/context-pack.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { NEVER_DROP, SECTION_ORDER, buildContextPack, estimateTokens, type ContextPackInput, type HandoffSummary } from '../../server/knowledge/context-pack.js';
import { makeFrozenSpec, makePlanTask } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const base: ContextPackInput = {
  kind: 'dev',
  role: 'dev',
  specHash: spec.specHash!,
  principles: ['Every acceptance test name carries its [AC-xxx] tag', 'Never modify frozen files'],
  outputContract: 'Return a JSON object matching the dev output schema.',
  task: makePlanTask({ id: 'T1-create', title: 'Create todo endpoint', criteriaRefs: ['AC-001'], dependsOn: ['T0-scaffold'], affectedPaths: ['src/todos/create/**'] }),
  criteria: [spec.acceptanceCriteria[0]!],
  budgetTokens: 4000,
};

describe('estimateTokens', () => {
  it('rounds up chars/4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('buildContextPack', () => {
  it('renders sections in the fixed order with the stable prefix first and is deterministic', () => {
    const a = buildContextPack(base);
    const b = buildContextPack(base);
    expect(a.text).toBe(b.text);
    expect(a.sections).toEqual(['principles', 'contract', 'task', 'criteria']);
    expect(a.text.indexOf('## Principles')).toBeLessThan(a.text.indexOf('## Output contract'));
    expect(a.text).toContain(`specHash: ${spec.specHash}`);
    expect(a.text).toContain('T1-create');
    expect(a.text).toContain('AC-001');
    expect(a.text).toContain('Given no todos exist');
    expect(a.dropped).toEqual([]);
    expect(a.tokens).toBe(estimateTokens(a.text));
  });

  it('includes optional sections when given, in order', () => {
    const pack = buildContextPack({
      ...base,
      objectives: ['Users can manage todo items'],
      techSpecExcerpt: 'POST /todos creates an item.',
      adrs: [{ id: 'ADR-001', title: 'Stack', text: 'Node 22 + Fastify' }],
      assumptions: ['T1: titles are trimmed (SM, 2026-09-24)'],
      handoffs: [{ taskId: 'T0-scaffold', title: 'Scaffold', summary: 'Project skeleton with Fastify server', changedFiles: ['package.json', 'src/index.ts'], mergedAt: '2026-09-24T10:00:00Z' }],
      code: { source: 'graph', nodes: [{ label: 'createTodo()', file: 'src/todos/create.ts', line: 10 }], affected: [{ label: 'router.ts', relation: 'imports', file: 'src/router.ts', line: 3 }], truncated: false },
      retrieval: [{ chunkId: 'spec-001#2', docId: 'spec-001', kind: 'spec', title: 'Spec 1', heading: 'Decisions', snippet: 'max [discount] 5', text: 'The maximum discount is 5 percent.', score: 1 }],
      feedback: 'Gate unit-test failed: [AC-001] returns 500',
    });
    expect(pack.sections).toEqual([...SECTION_ORDER]);
    expect(pack.text).toContain('src/todos/create.ts:10');
    expect(pack.text).toContain('router.ts [imports]');
    expect(pack.text).toContain('Spec 1 › Decisions');
    expect(pack.text.indexOf('## Feedback')).toBeGreaterThan(pack.text.indexOf('## Retrieved context'));
  });

  it('drops the lowest-priority sections whole when over budget and reports them', () => {
    const big = 'x'.repeat(4000);
    const pack = buildContextPack({
      ...base,
      budgetTokens: 1200,
      techSpecExcerpt: big,
      adrs: [{ id: 'ADR-001', title: 'Stack', text: big }],
      retrieval: [{ chunkId: 'c', docId: 'd', kind: 'spec', title: 't', heading: null, snippet: 's', text: big, score: 1 }],
      feedback: 'keep me',
    });
    expect(pack.tokens).toBeLessThanOrEqual(1200);
    expect(pack.dropped).toEqual(['retrieval', 'adrs', 'tech-spec']);
    expect(pack.sections).toEqual(['principles', 'contract', 'task', 'criteria', 'feedback']);
    expect(pack.text).toContain('Dropped for budget: retrieval, adrs, tech-spec');
  });

  it('never drops principles, contract, task or criteria and flags an impossible budget', () => {
    const pack = buildContextPack({ ...base, budgetTokens: 10 });
    expect(pack.sections).toEqual([...NEVER_DROP]);
    expect(pack.dropped).toContain('!over-budget');
    expect(pack.tokens).toBeGreaterThan(10);
  });

  it('caps handoffs to the newest six and cuts long summaries', () => {
    const handoffs: HandoffSummary[] = Array.from({ length: 10 }, (_, i) => ({
      taskId: `T${i}-x`,
      title: `Task ${i}`,
      summary: `summary ${i} `.repeat(100),
      changedFiles: [`src/${i}.ts`],
      mergedAt: `2026-09-2${i % 10}T0${i}:00:00Z`,
    }));
    const pack = buildContextPack({ ...base, handoffs });
    const start = pack.text.indexOf('## Handoffs');
    const rel = pack.text.slice(start + 3).search(/\n## (?!#)/);
    const section = pack.text.slice(start, rel === -1 ? pack.text.length : start + 3 + rel);
    const ids = [...section.matchAll(/### (T\d+-x)/g)].map((m) => m[1]);
    expect(ids).toHaveLength(6);
    expect(ids[0]).toBe('T9-x');
    expect(section.length).toBeLessThan(6 * 520);
  });

  it('renders the grep fallback and says why the graph was not used', () => {
    const pack = buildContextPack({ ...base, code: { source: 'grep', grep: [{ file: 'src/a.ts', line: 12, text: 'const discount = 5;' }] } });
    expect(pack.text).toContain('code graph unavailable or too thin');
    expect(pack.text).toContain('src/a.ts:12: const discount = 5;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/knowledge/context-pack.test.ts`
Expected: FAIL — cannot resolve `../../server/knowledge/context-pack.js`.

- [ ] **Step 3: Write the builder**

`server/knowledge/context-pack.ts`:
```ts
import type { StepKind } from '../agents/outputs.js';
import type { PlanTask } from '../contracts/plan.js';
import type { AcceptanceCriterion } from '../contracts/spec.js';
import type { AffectedNode, GraphNode } from './graphify.js';
import type { Hit } from './retrieval.js';

export interface HandoffSummary {
  taskId: string;
  title: string;
  summary: string;
  changedFiles: string[];
  mergedAt: string;
}

export interface CodeContext {
  source: 'graph' | 'grep' | 'none';
  nodes?: GraphNode[];
  affected?: AffectedNode[];
  grep?: Array<{ file: string; line: number; text: string }>;
  truncated?: boolean;
}

export interface ContextPackInput {
  kind: StepKind;
  role: string;
  specHash: string;
  principles: readonly string[];
  outputContract: string;
  task?: PlanTask;
  criteria: readonly AcceptanceCriterion[];
  objectives?: readonly string[];
  techSpecExcerpt?: string;
  adrs?: ReadonlyArray<{ id: string; title: string; text: string }>;
  assumptions?: readonly string[];
  handoffs?: readonly HandoffSummary[];
  code?: CodeContext;
  retrieval?: readonly Hit[];
  feedback?: string;
  budgetTokens: number;
}

export interface ContextPack {
  text: string;
  tokens: number;
  sections: string[];
  dropped: string[];
}

export const SECTION_ORDER = [
  'principles',
  'contract',
  'task',
  'criteria',
  'objectives',
  'tech-spec',
  'adrs',
  'assumptions',
  'handoffs',
  'code',
  'retrieval',
  'feedback',
] as const;
type Section = (typeof SECTION_ORDER)[number];

export const NEVER_DROP: readonly Section[] = ['principles', 'contract', 'task', 'criteria'];
/** Drop order when over budget; feedback last because a retry is useless without it. */
const DROP_ORDER: readonly Section[] = ['retrieval', 'code', 'adrs', 'tech-spec', 'objectives', 'handoffs', 'assumptions', 'feedback'];

const MAX_HANDOFFS = 6;
const HANDOFF_SUMMARY_CHARS = 400;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function render(input: ContextPackInput): Map<Section, string> {
  const out = new Map<Section, string>();
  out.set('principles', `## Principles\n${input.principles.map((p) => `- ${p}`).join('\n')}`);
  out.set(
    'contract',
    `## Output contract\nstep: ${input.kind} · role: ${input.role}\nspecHash: ${input.specHash}\nEcho this specHash in your output. ${input.outputContract}\nReference only the acceptance criteria, tasks, files and ADRs listed in this pack.`,
  );
  if (input.task) {
    const t = input.task;
    out.set(
      'task',
      `## Task ${t.id}: ${t.title}\n${t.description}\n- owner: ${t.owner}\n- dependsOn: ${t.dependsOn.join(', ') || 'none'}\n- affectedPaths: ${t.affectedPaths.join(', ')}\n- criteria: ${t.criteriaRefs.join(', ') || 'none'}`,
    );
  } else {
    out.set('task', `## Step\n${input.kind} for ${input.role}`);
  }
  out.set(
    'criteria',
    `## Acceptance criteria\n${input.criteria.map((c) => `- ${c.id}${c.smoke ? ' (smoke)' : ''}: Given ${c.given}, when ${c.when}, then ${c.then}`).join('\n') || '- none for this step'}`,
  );
  if (input.objectives?.length) out.set('objectives', `## Objectives\n${input.objectives.map((o) => `- ${o}`).join('\n')}`);
  if (input.techSpecExcerpt) out.set('tech-spec', `## Technical spec (excerpt)\n${input.techSpecExcerpt}`);
  if (input.adrs?.length) out.set('adrs', `## ADRs\n${input.adrs.map((a) => `### ${a.id}: ${a.title}\n${a.text}`).join('\n')}`);
  if (input.assumptions?.length) out.set('assumptions', `## Assumptions logged during this run\n${input.assumptions.map((a) => `- ${a}`).join('\n')}`);
  if (input.handoffs?.length) {
    const newest = [...input.handoffs].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, MAX_HANDOFFS);
    out.set(
      'handoffs',
      `## Handoffs (merged dependencies, newest first)\n${newest
        .map((h) => `### ${h.taskId}: ${h.title}\n${cut(h.summary, HANDOFF_SUMMARY_CHARS)}\nfiles: ${h.changedFiles.slice(0, 12).join(', ')}`)
        .join('\n')}`,
    );
  }
  if (input.code && input.code.source !== 'none') {
    if (input.code.source === 'graph') {
      const nodes = (input.code.nodes ?? []).map((n) => `- ${n.label} — ${n.file}${n.line ? `:${n.line}` : ''}`);
      const affected = (input.code.affected ?? []).map((a) => `- ${a.label} [${a.relation}] — ${a.file}${a.line ? `:${a.line}` : ''}`);
      out.set(
        'code',
        `## Code context (graph${input.code.truncated ? ', truncated — ask for more with graphify query' : ''})\n${nodes.join('\n') || '- no nodes'}${affected.length ? `\n### Impact radius\n${affected.join('\n')}` : ''}`,
      );
    } else {
      out.set('code', `## Code context (grep; code graph unavailable or too thin)\n${(input.code.grep ?? []).map((g) => `- ${g.file}:${g.line}: ${g.text}`).join('\n') || '- no matches'}`);
    }
  }
  if (input.retrieval?.length) {
    out.set('retrieval', `## Retrieved context\n${input.retrieval.map((h) => `### ${h.title}${h.heading ? ` › ${h.heading}` : ''} (${h.kind})\n${h.text}`).join('\n')}`);
  }
  if (input.feedback) out.set('feedback', `## Feedback from the previous attempt\n${input.feedback}`);
  return out;
}

function assemble(sections: Map<Section, string>, dropped: string[]): string {
  const parts = SECTION_ORDER.filter((s) => sections.has(s)).map((s) => sections.get(s)!);
  if (dropped.filter((d) => !d.startsWith('!')).length > 0) parts.push(`## Note\nDropped for budget: ${dropped.filter((d) => !d.startsWith('!')).join(', ')}`);
  return `${parts.join('\n\n')}\n`;
}

/** Deterministic, budgeted prompt for one agent step (spec §8.3, §9A.1). */
export function buildContextPack(input: ContextPackInput): ContextPack {
  const sections = render(input);
  const dropped: string[] = [];
  let text = assemble(sections, dropped);
  for (const s of DROP_ORDER) {
    if (estimateTokens(text) <= input.budgetTokens) break;
    if (!sections.has(s)) continue;
    sections.delete(s);
    dropped.push(s);
    text = assemble(sections, dropped);
  }
  if (estimateTokens(text) > input.budgetTokens) dropped.push('!over-budget');
  return { text, tokens: estimateTokens(text), sections: SECTION_ORDER.filter((s) => sections.has(s)), dropped };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/knowledge/context-pack.test.ts && npm run typecheck`
Expected: 7 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/knowledge/context-pack.ts test/knowledge/context-pack.test.ts
git commit -m "feat: add deterministic budgeted context pack builder" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Spec update

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` §15A

- [ ] **Step 1: Document the knowledge conventions**

Add to §15A:

```markdown
- **Knowledge:** text retrieval is BM25 over `node:sqlite` FTS5 (`porter unicode61`), chunked per Markdown heading (≤1200 chars); queries are sanitized to a bag of terms; documents are replaced on re-index. The code graph is `graphify update <repo> --no-cluster` run from `workspaces/<p>/graph/`; coverage = extracted/(extracted+failed) sources, below 0.5 the pack uses `git grep` instead. Context packs render sections in a fixed order (principles, contract, task, criteria, objectives, tech-spec, ADRs, assumptions, handoffs, code, retrieval, feedback), estimate tokens as chars/4 and drop whole sections from the end of `retrieval, code, adrs, tech-spec, objectives, handoffs, assumptions, feedback` until they fit; the first four sections are never dropped.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs: spec carries knowledge-layer conventions" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Integration against real graphify and docs (manual, WSL)

**Files:**
- Create: `scripts/integration/knowledge.ts`
- Modify: `docs/superpowers/spikes/2026-09-23-cli-findings.md`

- [ ] **Step 1: Write the script**

`scripts/integration/knowledge.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCommand } from '../../server/exec/command.js';
import { buildContextPack } from '../../server/knowledge/context-pack.js';
import { Graphify, MIN_COVERAGE, grepFallback } from '../../server/knowledge/graphify.js';
import { KnowledgeIndex } from '../../server/knowledge/retrieval.js';

const repo = path.resolve(process.argv[2] ?? '.');
const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-graph-'));
const g = new Graphify({ exec: execCommand, readFile: async (p) => fs.readFile(p, 'utf8').catch(() => null) });

console.log('== graphify update');
const cov = await g.update(repo, outDir);
console.log('  coverage', JSON.stringify(cov));
console.log('  god nodes', JSON.stringify(await g.godNodes(outDir, 5)));
const q = await g.query(outDir, 'how is a step result summarized', 600);
console.log(`  query: ${q.nodes.length} nodes, truncated=${q.truncated}`);
const aff = await g.affected(outDir, 'summarizeStream', 1);
console.log(`  affected: ${aff.length}`, aff.slice(0, 3));
const code = cov.ratio >= MIN_COVERAGE ? { source: 'graph' as const, nodes: q.nodes.slice(0, 8), affected: aff, truncated: q.truncated } : { source: 'grep' as const, grep: await grepFallback(repo, ['summarizeStream'], execCommand) };

console.log('== retrieval over docs/');
const idx = KnowledgeIndex.open(':memory:');
const docsDir = path.join(repo, 'docs');
const walk = async (dir: string): Promise<string[]> => (await fs.readdir(dir, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [path.join(dir, e.name)]));
let files: string[] = [];
for (const d of ['superpowers/specs', 'superpowers/spikes']) files = files.concat(await walk(path.join(docsDir, d)).catch(() => []));
for (const f of files.filter((f) => f.endsWith('.md'))) idx.index({ id: path.relative(repo, f), kind: f.includes('/specs/') ? 'spec' : 'other', title: path.basename(f), text: await fs.readFile(f, 'utf8') });
console.log(`  indexed ${idx.count()} chunks from ${files.length} files`);
for (const query of ['quota breaker rate limit reset', 'sandbox bubblewrap socat', 'merge queue head commit']) {
  const hits = idx.search(query, { k: 2 });
  console.log(`  "${query}" →`, hits.map((h) => `${h.title}${h.heading ? ' › ' + h.heading : ''} (${h.score.toFixed(2)})`));
}

const pack = buildContextPack({
  kind: 'dev',
  role: 'dev',
  specHash: `sha256:${'a'.repeat(64)}`,
  principles: ['Every acceptance test carries its [AC-xxx] tag'],
  outputContract: 'Return the dev output JSON.',
  criteria: [],
  code,
  retrieval: idx.search('quota breaker', { k: 2 }),
  budgetTokens: 3000,
});
console.log(`== pack: ${pack.tokens} tokens, sections ${pack.sections.join(',')}, dropped ${pack.dropped.join(',') || 'none'}`);
idx.close();
await fs.rm(outDir, { recursive: true, force: true });
```

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: Run inside WSL**

```bash
cd ~/workspace/teams-ai && git pull && npm ci && npx tsx scripts/integration/knowledge.ts .
```
Expected: coverage ratio ≥ 0.5 for this TypeScript repository; god nodes listed; query returns nodes; affected returns callers of `summarizeStream`; retrieval ranks the findings/spec sections for the three queries; pack under 3000 tokens with no `!over-budget`. Record the output and graphify's version under a "Knowledge integration" heading in the findings document, including the observed `graph.json` keys (`nodes`, `links`, `extracted_sources`, `failed_sources`) and the output formats the parsers rely on.

- [ ] **Step 3: Commit**

```bash
git add scripts/integration/knowledge.ts docs/superpowers/spikes
git commit -m "docs: add knowledge integration script and record graphify/retrieval results" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
