import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeIndex } from '../../server/knowledge/retrieval.js';

const HOLD_MS = 1500;
const holder = (file: string) =>
  spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => { db.exec('COMMIT'); }, ${HOLD_MS});`, file]);

describe('KnowledgeIndex under a concurrent writer', () => {
  it('waits for another process that holds the write lock, instead of failing with "database is locked"', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'teams-ai-lock-')), 'knowledge.sqlite');
    KnowledgeIndex.open(file).close();
    const other = holder(file);
    await new Promise((resolve) => other.stdout.once('data', resolve));
    const index = KnowledgeIndex.open(file);
    const started = Date.now();
    expect(() => index.index({ id: 'docs/a.md', kind: 'other', title: 'a', text: '# A\n\nTexto de apoio para o índice.' })).not.toThrow();
    expect(Date.now() - started).toBeGreaterThan(HOLD_MS / 2);
    index.close();
    other.kill();
  });
});
