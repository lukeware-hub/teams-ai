import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { RunDetail, StoredEvent } from '../api.js';
import { RunView } from './Run.js';

// jsdom gives import.meta.url an http: scheme; vitest runs with cwd = web/
const events: StoredEvent[] = readFileSync(path.resolve('../test/fixtures/runs/hello-run.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const detail: RunDetail = {
  runId: 'hello-001-r1',
  specId: 'hello-001',
  projectId: 'hello-app',
  status: 'paused:quota',
  state: { status: 'paused:quota', order: [], tasks: [] },
  finished: null,
  tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 },
  acceptanceCriteria: [
    { id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true },
    { id: 'AC-002', given: 'g', when: 'w', then: 't', smoke: false },
  ],
};
const view = (props: Partial<Parameters<typeof RunView>[0]> = {}) => (
  <MemoryRouter>
    <RunView detail={detail} events={events} ended={false} error={null} loadStep={vi.fn(async () => ({ prompt: '# p', output: { ok: true } }))} {...props} />
  </MemoryRouter>
);

describe('RunView', () => {
  it('renders header, phases, tasks grouped by state, tokens and evidence from the journal', () => {
    render(view());
    expect(screen.getByTestId('status').textContent).toContain('paused:quota');
    expect(screen.getByTestId('paused-until').textContent).toMatch(/until \d{2}:\d{2}/);
    expect(screen.getAllByTestId('phase').map((p) => p.textContent)).toEqual(['1 done', '2 done', '3 running']);
    expect(screen.getByTestId('group-merged').textContent).toContain('T1');
    expect(screen.getByTestId('group-ready').textContent).toContain('T2');
    expect(screen.getByTestId('tokens-dev').textContent).toContain('4100');
    expect(screen.getByTestId('evidence-AC-001').textContent).toContain('sum::[AC-001] adds');
    expect(screen.getByTestId('evidence-AC-002').textContent).toContain('no test');
  });
  it('selecting a task shows attempts, gates, review and the PR; a step expands to its artifacts', async () => {
    const loadStep = vi.fn(async () => ({ prompt: '# the prompt', output: { ok: true, value: { summary: 'did T1' } } }));
    render(view({ loadStep }));
    fireEvent.click(screen.getByTestId('task-T1'));
    expect(screen.getByTestId('attempt-1').textContent).toContain('lint');
    expect(screen.getByTestId('attempt-2').textContent).toContain('standard');
    expect(screen.getByText('PR #3').getAttribute('href')).toBe('https://github.com/o/r/pull/3');
    fireEvent.click(screen.getByTestId('step-s00003'));
    await screen.findByText(/# the prompt/);
    expect(loadStep).toHaveBeenCalledWith('s00003');
  });
  it('ignores a duplicate seq and shows the end state', () => {
    const dup = [...events, { ...events[3]! }];
    render(view({ detail: { ...detail, status: 'complete' }, events: dup, ended: true }));
    expect(screen.getByTestId('tokens-sm').textContent).toContain('1800'); // 1000 + 800, the duplicate STEP_FINISHED not double counted
    expect(screen.getByTestId('status').textContent).toContain('complete');
  });
});
