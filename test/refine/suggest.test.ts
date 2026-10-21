import { describe, expect, it } from 'vitest';
import { suggestPack } from '../../server/refine/suggest.js';
import type { DocFile } from '../../server/refine/draft.js';

const docs: Record<DocFile, string> = {
  'project.md': '# Projeto\n\nLoja online.',
  'briefing.md': '# Briefing\n\n## Decisões\n\n### Porta\n\n> A API responde na porta 8080.\n',
  'stack.md': '# Stack\n\n- Node 22',
  'flow.md': '# Fluxo\n\n```mermaid\nflowchart TD\n  A --> B\n```\n',
  'design.md': '# Design\n\nCores sóbrias.',
};
const pack = (file: 'design.md' | 'briefing.md') => suggestPack({ file, projectId: 'shop', specHash: 'sha256:' + 'a'.repeat(64), docs }).feedback ?? '';

describe('suggestPack (Sugerir)', () => {
  it('shows the other four documents, the precedence and the decision rule', () => {
    const feedback = pack('design.md');
    for (const other of ['### project.md', '### briefing.md', '### stack.md', '### flow.md']) expect(feedback).toContain(other);
    expect(feedback).toContain('the decisions recorded under "## Decisões" in the briefing first, then docs/flow.md, then the rest');
    expect(feedback).toContain('Never remove, reword or reorder a recorded decision');
  });

  it('shows the target once, from its current text, and not among the others', () => {
    const feedback = pack('design.md');
    expect(feedback.split('### current design.md').length - 1).toBe(1);
    expect(feedback).toContain('### current design.md\n# Design');
    expect(feedback).not.toContain('### design.md');
  });

  it('gives the briefing its own decisions while it is the target', () => {
    const feedback = pack('briefing.md');
    expect(feedback).toContain('### current briefing.md\n# Briefing\n\n## Decisões');
    expect(feedback).toContain('### project.md');
    expect(feedback).not.toContain('### briefing.md');
  });
});
