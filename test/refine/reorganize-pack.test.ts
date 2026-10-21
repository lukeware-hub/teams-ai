import { describe, expect, it } from 'vitest';
import { reorganizeGroups, reorganizePack } from '../../server/refine/packs.js';
import { MAX_DOCS_TOKENS } from '../../server/refine/docs-view.js';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';
import { RefineEvent } from '../../server/refine/events.js';

const base = { specHash: 'h', principles: [], specId: 'shop-001', projectMd: '# Projeto\n\nVisão.', briefMd: '# Brief\n\nObjetivo.', stackMd: '# Stack\n\nNode 22.', flowMd: '# Fluxo', designMd: '# Design\n\nCores.' };

describe('reorganization pack', () => {
  it('reads the changed document in full and the others as context', () => {
    const pack = reorganizePack({ ...base, changed: ['project.md'] });
    expect(String(pack.feedback).startsWith('REORGANIZE:')).toBe(true);
    expect(pack.feedback).toContain('### docs/project.md (reorganize in full)\n\n# Projeto\n\nVisão.');
    expect(pack.feedback).toContain('### docs/stack.md (context only, a digest)');
    expect(pack.feedback).not.toContain('(reorganize in full)\n\n# Stack');
  });

  it('asks for questions in place of guessed moves, and empty fields the pass does not fill', () => {
    const { feedback } = reorganizePack({ ...base, changed: ['stack.md'] });
    expect(feedback).toContain('goes where the charter tie-break puts it');
    expect(feedback).toContain('only when the charter leaves its right place open');
    expect(feedback).toContain('Never guess a move');
    expect(feedback).toContain('return empty `checklist`, `docPatch`, `findings` and `contradictions`');
  });

  it('keeps the briefing path of backlog mode', () => {
    const pack = reorganizePack({ ...base, changed: ['briefing.md'], projectBriefing: true });
    expect(pack.feedback).toContain('### docs/briefing.md (reorganize in full)');
  });
});

describe('reorganization groups', () => {
  const texts = { 'project.md': 'a', 'briefing.md': 'b', 'stack.md': 'c', 'flow.md': 'd', 'design.md': 'e' } as const;

  it('reads all the changed documents in one call when they fit', () => {
    expect(reorganizeGroups(['project.md', 'design.md'], texts)).toEqual([['project.md', 'design.md']]);
  });

  it('reads one document per call when they do not fit', () => {
    const big = { ...texts, 'project.md': 'x'.repeat(MAX_DOCS_TOKENS * 4 + 4) } as const;
    expect(reorganizeGroups(['project.md', 'design.md'], big)).toEqual([['project.md'], ['design.md']]);
  });
});

describe('reorganization state', () => {
  it('keeps the hash each document had after the last pass', () => {
    const s = emptyRefineState();
    expect(s.reorganized).toEqual({});
    applyRefineEvent(s, { type: RefineEvent.DocsReorganized, data: { cycle: 1, hashes: { 'project.md': 'abc' } } });
    expect(s.reorganized).toEqual({ 'project.md': 'abc' });
  });
});
