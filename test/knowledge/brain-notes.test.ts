import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../server/chat/store.js';
import { brainNotes, NOTE_LIMITS, type RunJournal } from '../../server/knowledge/brain-notes.js';
import type { StoredEvent } from '../../server/store/event-store.js';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, at = '2026-11-06T10:00:00.000Z'): StoredEvent =>
  ({ seq: ++seq, at, runId: 'r', specHash: 'h', type, kind: 'fact', data }) as StoredEvent;

const run = (runId: string, specId: string, events: StoredEvent[], at = '2026-11-06T10:00:00.000Z'): RunJournal => ({ runId, events: [ev('RUN_STARTED', { specId, runId }, at), ...events] });

const planned = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ev('TASK_PLANNED', { task: { id, title, description: `Faz ${title}`, criteriaRefs: ['AC-001'], affectedPaths: ['src/a.ts'], ...extra } });

const doc = (notes: ReturnType<typeof brainNotes>, file: string) => notes.docs.find((d) => d.file === file)?.text ?? '';

describe('brainNotes: tasks', () => {
  const journal = run('hello--spec-a--run-1', 'spec-a', [
    planned('T1', 'Registrar o nome'),
    ev('TASK_STATE_CHANGED', { taskId: 'T1', to: 'merged' }),
    ev('DEV_COMMITTED', { taskId: 'T1', changedFiles: ['src/a.ts', 'src/b.ts'], summary: 's' }),
  ]);

  it('writes one section per task with its criteria, files and last state', () => {
    const text = doc(brainNotes({ runs: [journal], chat: null }), 'brain/tasks/spec-a.md');
    expect(text).toContain('# Tarefas da spec spec-a');
    expect(text).toContain('## T1 — Registrar o nome');
    expect(text).toContain('Estado: merged. Execuções: 1.');
    expect(text).toContain('- AC-001');
    expect(text).toContain('- `src/a.ts`');
    expect(text).toContain('- `src/b.ts`');
  });

  it('links each task heading to the files it names or changed', () => {
    const { links } = brainNotes({ runs: [journal], chat: null });
    expect(links).toEqual([
      { noteFile: 'brain/tasks/spec-a.md', heading: 'T1 — Registrar o nome', path: 'src/a.ts' },
      { noteFile: 'brain/tasks/spec-a.md', heading: 'T1 — Registrar o nome', path: 'src/b.ts' },
    ]);
  });

  it('keeps the latest plan of a task across runs and counts the runs that planned it', () => {
    const again = run('hello--spec-a--run-2', 'spec-a', [planned('T1', 'Registrar o nome do cliente')], '2026-11-06T11:00:00.000Z');
    const text = doc(brainNotes({ runs: [again, journal], chat: null }), 'brain/tasks/spec-a.md');
    expect(text).toContain('## T1 — Registrar o nome do cliente');
    expect(text).toContain('Execuções: 2.');
  });

  it('leaves out a path that could escape the repository and a task with an unsafe id', () => {
    const odd = run('r1', 'spec-a', [planned('T1', 'x', { affectedPaths: ['../secret', '/etc/passwd', 'a b.ts', 'ok.ts'] }), planned('bad id', 'y')]);
    const notes = brainNotes({ runs: [odd], chat: null });
    const text = doc(notes, 'brain/tasks/spec-a.md');
    expect(text).toContain('- `ok.ts`');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('passwd');
    expect(text).not.toContain('bad id');
    expect(notes.links.map((l) => l.path)).toEqual(['ok.ts']);
  });

  it('writes no task note for a spec that planned no task', () => {
    const notes = brainNotes({ runs: [run('r1', 'spec-b', [])], chat: null });
    expect(notes.docs.map((d) => d.file)).toEqual(['brain/runs/spec-b.md']);
  });
});

describe('brainNotes: runs and failures', () => {
  it('says how each run ended, which tasks it blocked and which checks failed', () => {
    const journal = run('r1', 'spec-a', [
      ev('PHASE_FAILED', { phase: 2, reason: 'plan rejected' }),
      ev('VERIFICATION_FAILED', { round: 1, uncoveredAcs: ['AC-012', 'AC-013'] }),
      ev('DEPLOY_FAILED', { attempt: 1, stage: 'e2e', detail: 'AC-013: no e2e test' }),
      ev('GATE_FAILED', { taskId: 'T1', gate: 'unit-test' }),
      ev('RUN_FINISHED', { result: 'blocked', reason: 'review asked for changes', blocked: [{ taskId: 'T2', reason: 'README.md:33 missing' }] }),
    ]);
    const text = doc(brainNotes({ runs: [journal], chat: null }), 'brain/runs/spec-a.md');
    expect(text).toContain('## Execução 1 — blocked');
    expect(text).toContain('Motivo: review asked for changes');
    expect(text).toContain('- T2: README.md:33 missing');
    expect(text).toContain('- fase 2: plan rejected');
    expect(text).toContain('Critérios sem teste que passe: AC-012, AC-013');
    expect(text).toContain('- etapa e2e: AC-013: no e2e test');
    expect(text).toContain('Gates que falharam: 1.');
  });

  it('says a run has no recorded end instead of failing', () => {
    expect(doc(brainNotes({ runs: [run('r1', 'spec-a', [])], chat: null }), 'brain/runs/spec-a.md')).toContain('sem fim registrado');
  });

  it('numbers the runs of a spec oldest first and keeps only the latest ones', () => {
    const many = Array.from({ length: NOTE_LIMITS.runsPerSpec + 5 }, (_, i) => run(`r${String(i).padStart(3, '0')}`, 'spec-a', [ev('RUN_FINISHED', { result: 'done' })], `2026-11-06T10:${String(i % 60).padStart(2, '0')}:00.${String(i).padStart(3, '0')}Z`));
    const text = doc(brainNotes({ runs: many.reverse(), chat: null }), 'brain/runs/spec-a.md');
    expect(text).not.toContain('## Execução 1 —');
    expect(text).toContain(`## Execução ${NOTE_LIMITS.runsPerSpec + 5} —`);
    expect(text.match(/^## Execução /gm)).toHaveLength(NOTE_LIMITS.runsPerSpec);
  });

  it('ignores a journal that has no spec', () => {
    const notes = brainNotes({ runs: [{ runId: 'r', events: [ev('GATE_FAILED', {})] }], chat: null });
    expect(notes).toEqual({ docs: [], links: [] });
  });
});

describe('brainNotes: costs', () => {
  it('adds up the cost, the tokens and the steps by kind of each spec', () => {
    const step = (kind: string, costUsd: number) => ev('STEP_FINISHED', { kind, costUsd, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 1 } });
    const text = doc(brainNotes({ runs: [run('r1', 'spec-a', [step('dev', 0.5), step('dev', 0.25), step('review', 0.1)])], chat: null }), 'brain/costs.md');
    expect(text).toContain('Custo estimado US$ 0.8500. Tokens: 48. Passos por tipo: dev 2, review 1.');
  });

  it('writes no cost note when no step finished', () => {
    expect(brainNotes({ runs: [run('r1', 'spec-a', [])], chat: null }).docs.some((d) => d.file === 'brain/costs.md')).toBe(false);
  });
});

describe('brainNotes: chat', () => {
  const at = '2026-11-06T10:00:00.000Z';
  const chat: ChatMessage[] = [
    { role: 'user', text: 'Quantos serviços tem o projeto?', at },
    { role: 'assistant', text: 'Dois serviços.', at },
    { role: 'user', text: 'E o deploy?', at },
  ];

  it('keeps the questions and answers of an open project', () => {
    const text = doc(brainNotes({ runs: [], chat }), 'brain/chat.md');
    expect(text).toContain('## Quantos serviços tem o projeto?');
    expect(text).toContain('Resposta: Dois serviços.');
    expect(text).toContain('Pergunta: E o deploy?');
  });

  it('writes no chat note for a confidential project, even when it has a conversation', () => {
    expect(brainNotes({ runs: [], chat: null }).docs).toEqual([]);
  });

  it('writes no chat note for an empty conversation', () => {
    expect(brainNotes({ runs: [], chat: [] }).docs).toEqual([]);
  });

  it('keeps only the latest messages', () => {
    const long: ChatMessage[] = Array.from({ length: NOTE_LIMITS.chatMessages + 100 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i}`, at }));
    const text = doc(brainNotes({ runs: [], chat: long }), 'brain/chat.md');
    expect(text).not.toContain('Pergunta: msg 0\n');
    expect(text).toContain(`msg ${NOTE_LIMITS.chatMessages + 98}`);
  });
});

describe('brainNotes: safety', () => {
  it('masks a secret, flattens line breaks and drops a heading mark in untrusted text', () => {
    const journal = run('r1', 'spec-a', [ev('RUN_FINISHED', { result: 'blocked', reason: '# fake heading\nline two token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', blocked: [] })]);
    const text = doc(brainNotes({ runs: [journal], chat: null }), 'brain/runs/spec-a.md');
    expect(text).toContain('Motivo: fake heading line two');
    expect(text).not.toContain('sk-ant-api03');
    expect(text.split('\n').filter((l) => l.startsWith('#')).every((l) => l.startsWith('# Execuções') || l.startsWith('## Execução'))).toBe(true);
  });

  it('cuts a very long line', () => {
    const journal = run('r1', 'spec-a', [ev('RUN_FINISHED', { result: 'blocked', reason: 'x'.repeat(5000), blocked: [] })]);
    const line = doc(brainNotes({ runs: [journal], chat: null }), 'brain/runs/spec-a.md').split('\n').find((l) => l.startsWith('Motivo: '))!;
    expect(line.length).toBeLessThanOrEqual(NOTE_LIMITS.paragraph + 10);
    expect(line.endsWith('…')).toBe(true);
  });

  it('gives the same notes for the same journals in any order', () => {
    const a = run('r1', 'spec-a', [planned('T1', 'a')], '2026-11-06T10:00:00.000Z');
    const b = run('r2', 'spec-b', [planned('T1', 'b')], '2026-11-06T09:00:00.000Z');
    expect(brainNotes({ runs: [a, b], chat: null })).toEqual(brainNotes({ runs: [b, a], chat: null }));
  });
});
