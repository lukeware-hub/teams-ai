import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JournalEvent } from '../../server/refine/agreement.js';
import { ownerTexts, readInputTexts, readProposalSteps, renderReplay, replayProposals } from '../../server/refine/evidence-replay.js';
import { RefineEvent } from '../../server/refine/events.js';
import type { SpeckitInput } from '../../server/refine/speckit-pack.js';

const BRIEF = ['# Briefing', '', '## Regras', '', 'O link de recuperação de senha vale por 90 dias depois do envio.'].join('\n');
const LINK = 'O link de recuperação de senha vale por 90 dias depois do envio.';
const TEXTS = { 'project.md': '', 'flow.md': '', 'briefing.md': BRIEF, 'stack.md': '', 'design.md': '', 'specs.md': '' } as Record<SpeckitInput, string>;

describe('the replay of the saved proposals', () => {
  it('counts what each rule set admits, and joins each admitted or refused proposal with the owner later answer', () => {
    const steps = [
      { stepId: '000001', proposals: [
        { questionId: 'q1', answer: '90 dias', evidence: [{ source: 'briefing.md', quote: LINK }] },
        { questionId: 'q2', answer: '60 dias', evidence: [{ source: 'briefing.md', quote: LINK }] },
        { questionId: 'q3', answer: '90 dias', evidence: [{ source: 'docs/briefing.md', quote: LINK }] },
        { questionId: 'q4', answer: '90 dias', evidence: [{ source: 'briefing.md', quote: LINK }] },
      ] },
    ];
    const owner = { latest: new Map([['q1', '90 dias'], ['q2', '90 dias'], ['q3', '90 dias']]), texts: ['90 dias'] };
    const r = replayProposals(steps, TEXTS, owner);
    expect(r).toMatchObject({ steps: 1, proposals: 4, unlabelled: 1 });
    expect(r.admitted).toEqual({ strict: 2, sourceNames: 3, decisions: 2, perQuote: 2 });
    expect(r.gained).toEqual({ sourceNames: 1, decisions: 0, perQuote: 0 });
    expect(r.labelled.strict).toEqual({ same: 1, other: 0 });
    expect(r.labelled.sourceNames).toEqual({ same: 2, other: 0 });
    expect(r.refused).toEqual({ same: 1, other: 1 });
    expect(r.numbers).toEqual({ 'number-missing': 1 });
  });

  it('prints the header and the counts, which are zero for a draft with no saved answers', () => {
    const lines = renderReplay(replayProposals([], TEXTS, { latest: new Map(), texts: [] }));
    expect(lines[0]).toContain('six inputs of the last preparation');
    expect(lines.some((l) => l.startsWith('steps 0; proposals with an answer 0'))).toBe(true);
  });
});

describe('reading a draft folder', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-evidence-'));
    await fs.mkdir(path.join(root, 'speckit-input'), { recursive: true });
    for (const [file, text] of Object.entries(TEXTS)) await fs.writeFile(path.join(root, 'speckit-input', file), text);
    await fs.mkdir(path.join(root, 'steps', '000001'), { recursive: true });
    await fs.writeFile(path.join(root, 'steps', '000001', 'output.json'), JSON.stringify({
      ok: true,
      value: { specHash: 'x', results: [
        { questionId: 'q1', answer: '90 dias', evidence: [{ source: 'briefing.md', quote: LINK }], card: {} },
        { questionId: 'q2', answer: null, evidence: [], card: {} },
      ] },
    }));
    await fs.mkdir(path.join(root, 'steps', '000002'), { recursive: true });
    await fs.writeFile(path.join(root, 'steps', '000002', 'output.json'), JSON.stringify({ ok: false, failure: 'schema', errors: [] }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const started = (stepId: string, kind: string): JournalEvent => ({ type: 'STEP_STARTED', at: '2026-10-27T10:00:00.000Z', data: { stepId, kind } });

  it('reads only the answer steps that saved an output, and only the proposals with an answer', async () => {
    const events = [started('000001', 'speckit-answer'), started('000002', 'speckit-answer'), started('000003', 'speckit')];
    const steps = await readProposalSteps(root, events);
    expect(steps).toEqual([{ stepId: '000001', proposals: [{ questionId: 'q1', answer: '90 dias', evidence: [{ source: 'briefing.md', quote: LINK }] }] }]);
  });

  it('reads the six inputs, and the owner answers from the journal', async () => {
    expect((await readInputTexts(root))['briefing.md']).toBe(BRIEF);
    const events: JournalEvent[] = [
      { type: RefineEvent.QuestionAnswered, data: { questionId: 'q1', text: '30 dias' } },
      { type: RefineEvent.QuestionAnswered, data: { questionId: 'q1', text: '90 dias' } },
      { type: RefineEvent.QuestionAnswered, data: { questionId: 'q2', text: 'depende', by: 'po' } },
    ];
    expect(ownerTexts(events)).toEqual({ latest: new Map([['q1', '90 dias']]), texts: ['30 dias', '90 dias'] });
  });
});
