import { describe, expect, it } from 'vitest';
import { flowTemplate, stackTemplate } from '../../server/refine/draft.js';
import { refinePack } from '../../server/refine/packs.js';

const base = {
  specHash: 'sha256:' + 'a'.repeat(64),
  principles: [],
  specId: 'spec-1',
  projectMd: '# p',
  briefMd: '# b',
  derived: { project: {}, spec: { acceptanceCriteria: [], objectives: [] } },
  retrieval: [],
  history: [],
  rejected: [],
} as unknown as Parameters<typeof refinePack>[0];

describe('refinePack', () => {
  it('tells the front agent to review only and answer with the JSON object', () => {
    const { feedback } = refinePack({ ...base, role: 'front' });
    expect(feedback).toContain('This is a review, not an implementation task');
    expect(feedback).toContain('do not edit or create files');
  });

  it('asks the SM to fill a blank stack.md and flow.md instead of questioning the human, and keeps the PO out of it', () => {
    const blank = { ...base, stackMd: stackTemplate(), flowMd: flowTemplate() };
    const sm = refinePack({ ...blank, role: 'sm' }).feedback;
    expect(sm).toContain('only the blank template');
    expect(sm).toContain('docs/stack.md');
    expect(sm).toContain('docs/flow.md');
    expect(sm).toContain('Do NOT ask the human');
    const po = refinePack({ ...blank, role: 'po' }).feedback;
    expect(po).toContain('the SM fills them');
    expect(po).not.toContain('Do NOT ask the human');
    // once the files hold real content there is nothing to fill
    expect(refinePack({ ...base, role: 'sm', stackMd: '# Stack\n\n- Node 22\n', flowMd: '# Fluxo\n' }).feedback).not.toContain('only the blank template');
  });

  it('does not add the review-only rule for po', () => {
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('not an implementation task');
  });

  it('reviews the derived backlog instead of a spec in backlog mode, and keeps criteria empty', () => {
    const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'x' }], size: 'S', rank: 1 }], cycle: 1 };
    const pack = refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog, projectBriefing: true, rejected: [{ file: 'brief.md', find: 'old', decision: 'no' }] } as never);
    expect(pack.feedback).toContain('### docs/briefing.md');
    expect(pack.feedback).toContain('Patch files: docs/project.md, docs/briefing.md.');
    expect(pack.feedback).toContain('- docs/briefing.md: "old" → rejected: no');
    expect(pack.feedback).not.toContain('brief.md');
    expect(pack.feedback).toContain('### derived backlog');
    expect(pack.feedback).toContain('"key": "base"');
    expect(pack.feedback).not.toContain('### derived spec.json');
    expect(pack.feedback).toContain('Backlog mode');
    expect(pack.criteria).toEqual([]);
    expect(pack.objectives).toEqual(['Núcleo']);
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('Backlog mode');
  });
});
