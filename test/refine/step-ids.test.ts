import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stepId } from '../../server/core/ids.js';
import { RefineJournal } from '../../server/refine/session.js';

const ids = { projectId: 'hello-app', specId: 'hello-001' };
let root = '';

afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('step ids of a refinement journal', () => {
  it('a journal opened again hands out step ids that no earlier step used', async () => {
    root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-step-ids-'))).replace(/\\/g, '/');
    const file = `${root}/events.ndjson`;
    const used = new Set<string>();
    const first = await RefineJournal.open(file, ids);
    for (let i = 0; i < 2; i += 1) {
      const id = stepId(first.allocStepSeq());
      used.add(id);
      await first.fact('STEP_STARTED', { stepId: id });
    }
    await first.close();
    const second = await RefineJournal.open(file, ids);
    for (let i = 0; i < 3; i += 1) {
      const id = stepId(second.allocStepSeq());
      expect(used.has(id)).toBe(false);
      used.add(id);
      await second.fact('STEP_STARTED', { stepId: id });
    }
    await second.close();
  });
});
