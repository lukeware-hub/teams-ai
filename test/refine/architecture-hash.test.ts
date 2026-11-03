import { describe, expect, it } from 'vitest';
import { docsHashOf } from '../../server/refine/architecture-step.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';
import type { DocFile } from '../../server/refine/draft.js';

const docs = (briefing: string) => Object.fromEntries(DOC_STAGES.map((f) => [f, f === 'briefing.md' ? briefing : `# ${f}`])) as Record<DocFile, string>;

describe('docsHashOf', () => {
  it('ignores the recorded decisions of the briefing', () => {
    const base = '# Briefing\n\nTexto.\n';
    expect(docsHashOf(docs(`${base}\n## Decisões\n\n- **Pergunta?** Resposta.\n`))).toBe(docsHashOf(docs(base)));
  });

  it('changes when the briefing text changes', () => {
    expect(docsHashOf(docs('# Briefing\n\nTexto.\n'))).not.toBe(docsHashOf(docs('# Briefing\n\nOutro.\n')));
  });
});
