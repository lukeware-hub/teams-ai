import { describe, expect, it } from 'vitest';
import { DOCUMENT_CHARTER, DOCUMENT_PURPOSE } from '../../server/agents/document-charter.js';

describe('document charter', () => {
  it('flow.md is the complete business flow, as one Mermaid diagram', () => {
    expect(DOCUMENT_CHARTER).toMatch(/flow\.md: the complete business flow of the system, as one Mermaid diagram/);
  });

  it('project.md holds goals and deliverables; the briefing holds the detailed behavior and the explanation of each step', () => {
    expect(DOCUMENT_CHARTER).toMatch(/project\.md: what the product is: .*goals, the deliverables it must produce/);
    expect(DOCUMENT_CHARTER).toMatch(/briefing[^\n]*how the software works in detail[^\n]*a written explanation of each step of docs\/flow\.md/);
  });

  it('stack.md holds the rules of use: what must not be used and the best practices', () => {
    expect(DOCUMENT_CHARTER).toMatch(/stack\.md: [^\n]*the rules of use: what must not be used/);
  });

  it('a step drawn in flow.md keeps its explanation in the briefing; a new step or branch belongs to flow.md', () => {
    expect(DOCUMENT_CHARTER).toContain('A step, an order or a branch that docs/flow.md does not draw belongs to docs/flow.md');
    expect(DOCUMENT_CHARTER).toContain('a written explanation of a step that docs/flow.md draws stays in the briefing');
  });

  it('each Jev purpose names what the charter gives its document', () => {
    expect(DOCUMENT_PURPOSE['project.md']).toMatch(/goals.*deliverables/);
    expect(DOCUMENT_PURPOSE['briefing.md']).toContain('a written explanation of each flow step');
    expect(DOCUMENT_PURPOSE['stack.md']).toContain('the rules of use');
    expect(DOCUMENT_PURPOSE['flow.md']).toContain('the complete business flow of the system');
  });
});
