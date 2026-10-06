import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';

const AGENTS = path.resolve('.claude/agents');

describe('agent policy for the backlog', () => {
  it('tells the PO how to break the docs down, prioritize, cite and keep keys, and still loads as an agent file', async () => {
    const agents = await loadAgents(AGENTS);
    const po = agents.po.body;
    expect(po).toContain('(`backlog` step)');
    for (const phrase of ['smallest deliverable one run can ship', 'P0 = the walking skeleton', 'cited by at least one item', 'is binding', 'Keep the key of every item']) {
      expect(po, phrase).toContain(phrase);
    }
  });

  it('tells the SM to review dependency order and feasibility of a derived backlog without asking about service decomposition', async () => {
    const sm = (await loadAgents(AGENTS)).sm.body;
    expect(sm).toContain('### Reviewing a backlog');
    expect(sm).toContain('deliverable in one run');
    expect(sm).toContain('never a question for the human');
  });

  it('keeps the derive and refine sections of the PO', async () => {
    const po = (await fs.readFile(path.join(AGENTS, 'po.md'), 'utf8'));
    expect(po).toContain('(`derive` step)');
    expect(po).toContain('(`refine` step)');
  });
});
