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

  it('tells the SM to review dependency order and feasibility of a derived backlog, asking a split the docs leave open as in refinement', async () => {
    const sm = (await loadAgents(AGENTS)).sm.body;
    const review = sm.slice(sm.indexOf('### Reviewing a backlog'));
    expect(review).toContain('deliverable in one run');
    expect(review).toContain('The service and bounded-context decomposition rule above still applies');
    expect(sm).not.toContain('never a question for the human');
  });

  it('tells the PO how to detail a backlog item into a spec and where a backlog decision is written', async () => {
    const po = (await loadAgents(AGENTS)).po.body;
    expect(po).toContain('## Detailing a backlog item (`spec` step)');
    for (const phrase of ['one entry per item', 'testable end to end', 'echo the previous id', 'do not read files', 'only through the docs']) expect(po, phrase).toContain(phrase);
    const review = po.slice(po.indexOf('### Reviewing a backlog (PO)'));
    expect(review).toContain('docs/briefing.md');
    expect(review).not.toContain('docs/specs/<specId>/brief.md');
  });

  it('tells the SM how to pre-plan a backlog spec', async () => {
    const sm = (await loadAgents(AGENTS)).sm.body;
    expect(sm).toContain('## Pre-planning a backlog spec (`preplan` step)');
    for (const phrase of ['one entry per spec', 'cites at least one acceptance criterion of its own spec', 'walking skeleton', 'the real plan is made at execution', 'do not read files']) expect(sm, phrase).toContain(phrase);
    const review = sm.slice(sm.indexOf('### Reviewing a backlog'));
    expect(review).toContain('docs/briefing.md');
  });

  it('keeps the derive and refine sections of the PO', async () => {
    const po = (await fs.readFile(path.join(AGENTS, 'po.md'), 'utf8'));
    expect(po).toContain('(`derive` step)');
    expect(po).toContain('(`refine` step)');
  });
});

describe('front agent policy', () => {
  it('names the target project briefing of backlog mode among the sources of truth', async () => {
    const front = (await loadAgents(AGENTS)).front.body;
    expect(front).toContain('docs/briefing.md');
  });
});

describe('changing a detailed spec', () => {
  it('goes through the briefing or a question in the PO policy and in the review pack, never a patch the pack does not allow', async () => {
    const po = (await loadAgents(AGENTS)).po.body;
    const detailing = po.slice(po.indexOf('## Detailing a backlog item'), po.indexOf('## Refining the documentation'));
    expect(detailing).toContain('docs/briefing.md');
    expect(detailing).not.toContain('patch the doc section it cites');
    const { refinePack } = await import('../../server/refine/packs.js');
    const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [], cycle: 1, detail: true, flowHeadings: [], specs: {}, preplans: {} };
    const pack = refinePack({ role: 'po', specHash: `sha256:${'a'.repeat(64)}`, principles: [], specId: 's-1', projectMd: '# p', briefMd: '# b', derived: { project: {}, spec: null }, backlog, retrieval: [], history: [], rejected: [], projectBriefing: true, cycle: 2 } as never);
    expect(pack.feedback).not.toContain('patch the doc section it cites');
    expect(pack.feedback).toMatch(/record the decision in docs\/briefing\.md/);
  });
});
