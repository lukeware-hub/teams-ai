import { describe, expect, it } from 'vitest';
import { backlogProgress, type ProgressInput } from './backlog-progress.js';

const items = ['a', 'b', 'c', 'd'].map((key) => ({ key, title: key.toUpperCase() }));
const ok = (id: string, passed = true, detail = '') => ({ id, ok: passed, detail });
const allChecks = (over: Record<string, boolean> = {}) =>
  ['documents', 'architecture', 'specs', 'plans', 'tasks', 'dependencies', 'questions'].map((id) => ok(id, over[id] ?? true));
const base = (over: Partial<ProgressInput> = {}): ProgressInput => ({
  items, detailed: ['a', 'b', 'c', 'd'], steps: [], running: [], repositories: true,
  checks: allChecks({ architecture: false, plans: false, tasks: false }), architectureRunning: false, closed: false, ...over,
});

describe('backlogProgress', () => {
  it('counts one unit per finished piece of work over the expected total', () => {
    // 4 items: 4 specs + 4 plans + 4 task lists, plus documents, dependencies, architecture and questions.
    const none = backlogProgress(base());
    expect(none.total).toBe(16);
    expect(none.done).toBe(7);
    const some = backlogProgress(base({ steps: [{ command: 'plan', itemKey: 'a' }, { command: 'plan', itemKey: 'b' }, { command: 'tasks', itemKey: 'a' }] }));
    expect(some.done).toBe(10);
    expect(some.percent).toBe(63);
  });

  it('has no task lists in a session without repositories', () => {
    const out = backlogProgress(base({ repositories: false }));
    expect(out.total).toBe(12);
    expect(out.rows.find((r) => r.id === 'tasks')).toBeUndefined();
  });

  it('counts a step reused from an earlier run and ignores steps of items not in the backlog', () => {
    const out = backlogProgress(base({ steps: [{ command: 'plan', itemKey: 'a', reused: true }, { command: 'plan', itemKey: 'zzz' }, { command: 'plan', itemKey: 'a' }] }));
    expect(out.rows.find((r) => r.id === 'plans')?.value).toBe('1 de 4');
  });

  it('stops at 99 until the closing is complete, and reaches 100 when it is', () => {
    const all = base({ steps: items.flatMap((i) => [{ command: 'plan', itemKey: i.key }, { command: 'tasks', itemKey: i.key }]), checks: allChecks() });
    expect(backlogProgress({ ...all, closed: false }).percent).toBe(99);
    expect(backlogProgress({ ...all, closed: true }).percent).toBe(100);
  });

  it('marks a check with its reason and keeps the state off colour alone', () => {
    const out = backlogProgress(base({ checks: allChecks({ questions: false }).map((c) => (c.id === 'questions' ? { ...c, detail: 'revise antes de iniciar' } : c)) }));
    const row = out.rows.find((r) => r.id === 'questions');
    expect(row?.state).toBe('problem');
    expect(row?.value).toBe('precisa de revisão');
  });

  it('shows what runs now: plans, task lists, the architecture, and the overflow', () => {
    const out = backlogProgress(base({
      architectureRunning: true,
      running: ['a', 'b', 'c', 'd'].map((k, i) => ({ command: i % 2 ? 'tasks' : 'plan', itemKey: k, startedAt: '2026-11-11T10:00:00Z' })),
    }));
    expect(out.now).toHaveLength(4);
    expect(out.now[0]?.label).toBe('Decidindo a arquitetura');
    expect(out.now[1]).toMatchObject({ label: 'Plano de A', since: '2026-11-11T10:00:00Z' });
    expect(out.now[2]?.label).toBe('Lista de tarefas de B');
    expect(out.more).toBe(1);
  });

  it('marks planning rows in progress only while something of that kind runs', () => {
    const out = backlogProgress(base({ running: [{ command: 'plan', itemKey: 'a' }], steps: [{ command: 'plan', itemKey: 'b' }] }));
    expect(out.rows.find((r) => r.id === 'plans')?.state).toBe('current');
    expect(out.rows.find((r) => r.id === 'tasks')?.state).toBe('ahead');
  });
});
