import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunDetail } from '../api.js';
import { RunPage } from './Run.js';

const run = vi.fn();
const resumeRun = vi.fn();
vi.mock('../api.js', async (original) => ({
  ...(await original<typeof import('../api.js')>()),
  runApi: { run: (id: string) => run(id), resumeRun: (id: string) => resumeRun(id), runEvents: (id: string) => `/api/runs/${id}/events`, step: vi.fn() },
}));

class FakeEventSource {
  static urls: string[] = [];
  static CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    FakeEventSource.urls.push(url);
  }
  addEventListener() {}
  close() {}
}

const detail = (status: string): RunDetail =>
  ({
    runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status, phase: 3, report: null, locked: false, agentsDecide: false,
    state: { status: 'running', order: [], tasks: [] }, finished: null, gapDecisions: [], decisions: [], acceptanceCriteria: [], plan: null,
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 },
  }) as unknown as RunDetail;

beforeEach(() => {
  FakeEventSource.urls = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RunPage resume', () => {
  it('opens the event stream again, because the server closed the first one at the earlier end of the run', async () => {
    run.mockResolvedValueOnce(detail('verification-failed')).mockResolvedValue(detail('running'));
    resumeRun.mockResolvedValue({ runId: 'hello-001-r1' });
    render(
      <MemoryRouter initialEntries={['/runs/hello-001-r1']}>
        <Routes>
          <Route path="/runs/:runId" element={<RunPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId('resume'));
    await waitFor(() => expect(FakeEventSource.urls).toHaveLength(2));
    expect(FakeEventSource.urls[1]).not.toBe(FakeEventSource.urls[0]);
  });
});
