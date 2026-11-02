import { describe, expect, it, vi } from 'vitest';
import { checkGaps, type GapContext } from '../../server/orchestrator/phases/gaps.js';
import { gapsPack, type PackBase } from '../../server/orchestrator/steps.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/index.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT = '/ws/snapshot-1';
const LEGACY_READ = 'Read the section in docs/ (the file before the arrow';
const sections = [{ doc: 'briefing.md', heading: 'Create a todo' }];
const spec = makeFrozenSpec({
  derivedFrom: {
    backlogKey: 'todos',
    inputHash: HASH,
    docsHash: HASH,
    sources: [{ doc: 'briefing.md', heading: 'Create a todo', hash: HASH, bodyHash: HASH }],
  },
});

const base = (docsRoot?: string): PackBase => ({ spec, project: makeProject(), specHash: HASH, assumptions: [], budgetTokens: 8000, docsRoot }) as PackBase;

const context = (): GapContext => ({ evidence: [], tasks: new Map(), reasonOf: () => 'blocked', result: 'awaiting-validation' });

describe('gap pack', () => {
  it('tells a docs-repo gap check to read the five documents from the snapshot root', () => {
    const { feedback } = gapsPack(base(SNAPSHOT), { sections });
    expect(feedback).toContain(`Read the section in ${SNAPSHOT}/docs/ (the file before the arrow`);
    expect(feedback).not.toContain(LEGACY_READ);
  });

  it('keeps the legacy wording for a legacy project, which reads docs/ of its checkout', () => {
    const { feedback } = gapsPack(base(), { sections });
    expect(feedback).toContain(LEGACY_READ);
    expect(feedback).not.toContain(SNAPSHOT);
  });

  it('a docs-repo gap check hands the agent the snapshot root in its pack, and runs in the code checkout', async () => {
    const answer = { specHash: HASH, items: [{ doc: 'briefing.md', heading: 'Create a todo', status: 'delivered', evidence: ['server/todos.ts:1'], missing: '', acIds: ['AC-001'] }] };
    const runAgent = vi.fn(async (_req: unknown): Promise<StepOutcome<unknown>> => ({ ok: true, value: answer, summary: {} as ResultSummary }));
    const deps = { spec, project: makeProject(), specHash: HASH, runAgent, packBase: () => base(SNAPSHOT) } as unknown as PhaseDeps;
    await checkGaps(deps, '/wt', context());
    const req = runAgent.mock.calls[0]![0] as { cwd: string; pack: { feedback: string } };
    expect(req.cwd).toBe('/wt');
    expect(req.pack.feedback).toContain(`${SNAPSHOT}/docs/`);
  });
});
