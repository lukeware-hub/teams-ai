import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCycle } from '../../server/refine/cycle.js';
import { emptyRefineState } from '../../server/refine/state.js';

describe('refinement cycle Jev gate', () => {
  it('blocks derivation on a grave document inconsistency', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'demo',
      specId: 'demo-001',
      root,
      docs,
      projectMd: path.join(docs, 'project.md'),
      projectJson: path.join(docs, 'project.json'),
      briefMd: path.join(docs, 'brief.md'),
      stackMd: path.join(docs, 'stack.md'),
      flowMd: path.join(docs, 'flow.md'),
      designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'),
      events: path.join(root, 'events.ndjson'),
      steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([
      writeFile(draft.projectMd, '# Project'),
      writeFile(draft.briefMd, '# Brief'),
      writeFile(draft.stackMd, '# Stack'),
      writeFile(draft.flowMd, '# Flow'),
      writeFile(draft.designMd, '# Design'),
    ]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = {
      state: emptyRefineState(),
      allocStepSeq: () => 1,
      fact: async (type: string, data: Record<string, unknown>) => {
        events.push({ type, data });
        return { seq: events.length, at: '', runId: 'demo/demo-001', specHash: 'draft', type, kind: 'fact' as const, data };
      },
    };
    const runAgent = vi.fn();
    await runCycle({
      draft,
      journal,
      runAgent: runAgent as never,
      principles: () => [],
      retrieval: () => [],
      secretsDir: root,
      validateDocs: async () => ({ available: true, decision: 'blocked' as const, consistent: false, confidence: 0.99, model: 'jev', checks: { documents_consistent: 0.2 }, stateTruncated: false }),
    }, 1);
    expect(events.some((event) => event.type === 'REFINE_CYCLE_FAILED')).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
