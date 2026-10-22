import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { elapsedText, lastEvaluationText, ProcessingBanner } from './ProcessingBanner.js';

describe('elapsedText', () => {
  const since = '2026-10-21T10:00:00Z';

  it('counts minutes and seconds from the start of the evaluation', () => {
    expect(elapsedText(since, Date.parse('2026-10-21T10:03:05Z'))).toBe('03:05');
  });

  it('shows the hours from an hour on, and never a negative time', () => {
    expect(elapsedText(since, Date.parse('2026-10-21T11:02:03Z'))).toBe('1:02:03');
    expect(elapsedText(since, Date.parse('2026-10-21T09:59:00Z'))).toBe('00:00');
  });
});

describe('lastEvaluationText', () => {
  it('shows a dash before any evaluation, or when its times are missing', () => {
    expect(lastEvaluationText(undefined)).toBe('—');
    expect(lastEvaluationText({ startedAt: '', endedAt: null })).toBe('—');
    expect(lastEvaluationText({ startedAt: '2026-10-21T10:00:00Z', endedAt: '' })).toBe('—');
  });

  it('shows that the evaluation is still running', () => {
    expect(lastEvaluationText({ startedAt: '2026-10-21T10:00:00Z', endedAt: null })).toBe('em andamento');
  });

  it('shows how long a finished evaluation took', () => {
    expect(lastEvaluationText({ startedAt: '2026-10-21T10:00:00Z', endedAt: '2026-10-21T10:00:45Z' })).toBe('45 s');
    expect(lastEvaluationText({ startedAt: '2026-10-21T10:00:00Z', endedAt: '2026-10-21T10:02:05Z' })).toBe('2 min 5 s');
  });
});

describe('the evaluation timer on the banner', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const banner = (since: string | null) => <ProcessingBanner backlog={null} cycle={2} stage="Claude" jevDown={false} since={since} />;

  it('counts from the start of the evaluation, once a second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-21T10:00:00Z'));
    render(banner('2026-10-21T10:00:00Z'));
    expect(screen.getByTestId('evaluation-timer').textContent).toBe('Tempo: 00:00');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('evaluation-timer').textContent).toBe('Tempo: 00:05');
  });

  it('shows no timer without a start', () => {
    render(banner(null));
    expect(screen.queryByTestId('evaluation-timer')).toBeNull();
  });

  it('stops its tick when the banner goes away', () => {
    vi.useFakeTimers();
    const { unmount } = render(banner('2026-10-21T10:00:00Z'));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
