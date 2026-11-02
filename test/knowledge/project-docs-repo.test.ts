import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openProjectKnowledge } from '../../server/knowledge/project-docs.js';

const SPEC = '# Orders: discounts\nCustomers with the VIP tier receive a discount of 5 percent.\n';

describe('openProjectKnowledge of a documentation repository (plan 119, I8 item 6)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-project-docs-repo-'));
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const write = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), text);
  };

  it('indexes a spec of the specify folder as a spec of its alias, in both layouts', async () => {
    await write('docs/specify/orders-001/spec.md', SPEC);
    await write('docs/orders-api/specify/orders-002/spec.md', SPEC.replace('discount', 'refund'));

    const index = await openProjectKnowledge(':memory:', repo);

    expect(index.search('discount', { specId: 'orders-001' })).toEqual([expect.objectContaining({ docId: 'docs/specify/orders-001/spec.md', kind: 'spec' })]);
    expect(index.search('refund', { specId: 'orders-002' })).toEqual([expect.objectContaining({ docId: 'docs/orders-api/specify/orders-002/spec.md', kind: 'spec' })]);
  });
});
