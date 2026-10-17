import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProjectKnowledge } from '../../server/knowledge/project-docs.js';

const SPEC = `# Spec 1: discounts
Customers with the VIP tier receive a discount of 5 percent.
`;
const ADR = `# ADR-002: Authentication
We use JWT bearer tokens. Sessions are stateless.
`;

describe('openProjectKnowledge', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-project-docs-'));
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), text);
  };

  it('indexes the spec and ADR documents of the docs folder, ignoring other files', async () => {
    await write('docs/specs/spec-1/spec.md', SPEC);
    await write('docs/adr/ADR-002.md', ADR);
    await write('docs/notes.txt', 'discount notes that are not markdown');

    const index = await openProjectKnowledge(':memory:', repo);

    expect(index.search('discount')).toEqual([expect.objectContaining({ docId: 'docs/specs/spec-1/spec.md', kind: 'spec' })]);
    expect(index.search('JWT')).toEqual([expect.objectContaining({ docId: 'docs/adr/ADR-002.md', kind: 'adr' })]);
  });

  it('returns an empty index when the repository has no docs folder', async () => {
    const index = await openProjectKnowledge(':memory:', repo);

    expect(index.search('discount')).toEqual([]);
  });
});
