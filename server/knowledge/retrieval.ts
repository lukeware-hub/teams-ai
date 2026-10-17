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
  private constructor(private readonly db: DatabaseSync, private readonly fts5: boolean) {}

  static open(file: string | ':memory:'): KnowledgeIndex {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, spec_id TEXT);
      CREATE TABLE IF NOT EXISTS chunks (chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, heading TEXT, text TEXT NOT NULL);
      PRAGMA foreign_keys = ON;
    `);
    let fts5 = true;
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(heading, text, content='chunks', content_rowid='rowid', tokenize='porter unicode61');
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.rowid, new.heading, new.text); END;
        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, heading, text) VALUES ('delete', old.rowid, old.heading, old.text); END;
      `);
    } catch {
      // Official Node builds may expose node:sqlite without compiling the FTS5 extension.
      fts5 = false;
      db.exec('DROP TRIGGER IF EXISTS chunks_ai; DROP TRIGGER IF EXISTS chunks_ad;');
    }
    return new KnowledgeIndex(db, fts5);
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

  documentIds(): string[] {
    return (this.db.prepare('SELECT id FROM docs').all() as Array<{ id: string }>).map((row) => row.id);
  }

  search(query: string, opts: { k?: number; kinds?: DocKind[]; specId?: string } = {}): Hit[] {
    const bag = sanitizeQuery(query);
    if (bag === '') return [];
    if (!this.fts5) return this.searchWithoutFts5(bag, opts);
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

  private searchWithoutFts5(bag: string, opts: { k?: number; kinds?: DocKind[]; specId?: string }): Hit[] {
    const terms = bag.toLocaleLowerCase().split(' ');
    const allowedKinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : undefined;
    const rows = this.db
      .prepare(
        `SELECT c.chunk_id, c.doc_id, d.kind, d.title, c.heading, c.text, c.ordinal, d.spec_id
         FROM chunks c JOIN docs d ON d.id = c.doc_id
         ORDER BY c.doc_id, c.ordinal`,
      )
      .all() as Array<{ chunk_id: string; doc_id: string; kind: DocKind; title: string; heading: string | null; text: string; ordinal: number; spec_id: string | null }>;
    const hits = rows.flatMap((row) => {
      if (allowedKinds && !allowedKinds.has(row.kind)) return [];
      if (opts.specId && row.spec_id !== null && row.spec_id !== opts.specId) return [];
      const haystack = `${row.heading ?? ''} ${row.text}`;
      const tokens = new Set(haystack.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
      const matched = terms.filter((term) => tokens.has(term));
      if (matched.length === 0) return [];
      const first = matched[0];
      const offset = haystack.toLocaleLowerCase().indexOf(first);
      const start = Math.max(0, offset - 60);
      const snippet = haystack.slice(start, start + 180);
      return [{
        chunkId: row.chunk_id,
        docId: row.doc_id,
        kind: row.kind,
        title: row.title,
        heading: row.heading,
        snippet,
        text: row.text,
        score: matched.length / terms.length,
      }];
    });
    return hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId)).slice(0, opts.k ?? 8);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
