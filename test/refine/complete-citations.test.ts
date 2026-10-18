import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { completeCitations } from '../../server/refine/backlog.js';
import { flowHeadings, validateBacklog } from '../../server/validators/backlog.js';

const flow = [
  '## 33. Máquinas de estado canônicas',
  'Todo comando carrega `idempotency_key`.',
  '### 33.1 `Case` (`case-evidence`)',
  'Transições do caso.',
  '### 33.2 `Task` (`workflow-task-sla`)',
  'Transições da tarefa.',
].join('\n');
const design = ['## 2. Tokens semânticos', '### 2.1 Cores', 'Azul.', '### 2.2 Tipos', 'Fonte.'].join('\n');
const docs = { 'flow.md': flow, 'design.md': design };
const item = (key: string, sources: BacklogItem['sources']) =>
  ({ key, title: key, epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources, size: 'S' }) as unknown as BacklogItem;

describe('completeCitations', () => {
  it('cites a section with text of its own through the item that cites one of its sub-sections', () => {
    const [done] = completeCitations([item('case', [{ doc: 'flow.md', heading: '33.1 `Case` (`case-evidence`)' }])], docs, new Set());
    expect(done!.sources).toContainEqual({ doc: 'flow.md', heading: '33. Máquinas de estado canônicas' });
  });

  it('leaves a started item as it is', () => {
    const started = item('case', [{ doc: 'flow.md', heading: '33.1 `Case` (`case-evidence`)' }]);
    const [done] = completeCitations([started], docs, new Set(['case']));
    expect(done!.sources).toEqual(started.sources);
  });

  it('gives the validator every flow section cited, so the outline is not refused for the section with text of its own', () => {
    const items = [item('case', [{ doc: 'flow.md', heading: '33.1 `Case` (`case-evidence`)' }, { doc: 'flow.md', heading: '33.2 `Task` (`workflow-task-sla`)' }])];
    const errors = validateBacklog({ epics: [{ key: 'core', title: 'Core' }], items: completeCitations(items, docs, new Set()) }, { flowHeadings: flowHeadings(flow), docs, frozen: new Set() });
    expect(errors.filter((e) => e.includes('sem nenhum item'))).toEqual([]);
  });
});
