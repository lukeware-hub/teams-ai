import { describe, expect, it } from 'vitest';
import { flowOutline } from '../../server/knowledge/flow-outline.js';

const flow = [
  '```mermaid',
  'flowchart TD',
  'subgraph GOV["0. Governança da plataforma — existe antes do primeiro caso"]',
  '  A --> B',
  '  subgraph INNER[1.1 Aprovação]',
  '    C --> D',
  '  end',
  'end',
  'subgraph LOOSE',
  '  E --> F',
  'end',
  '```',
].join('\n');

describe('flowOutline', () => {
  it('turns each subgraph title into a heading, quoted or not, nested ones included', () => {
    expect(flowOutline(flow)).toBe('# Etapas do flow.md\n\n## 0. Governança da plataforma — existe antes do primeiro caso\n\n## 1.1 Aprovação\n\n## LOOSE\n');
  });

  it('gives nothing when the flow has no subgraph', () => {
    expect(flowOutline('```mermaid\nflowchart TD\nA --> B\n```')).toBeNull();
  });
});
