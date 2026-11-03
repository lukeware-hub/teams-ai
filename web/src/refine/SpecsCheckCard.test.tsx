import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpecsCheck } from './SpecsCheck.js';

describe('the specs.md card', () => {
  it('offers Tentar de novo when nothing was written and nothing runs, and calls the retry', () => {
    const onRetry = vi.fn();
    render(<SpecsCheck specsMd={null} reviews={{}} busy={false} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('specs-check-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the file and both reviewers as running, with no retry, while the work runs', () => {
    render(<SpecsCheck specsMd={null} reviews={{}} busy onRetry={() => undefined} />);
    expect(screen.getByTestId('specs-check-file-status').textContent).toBe('Gerando');
    expect(screen.getByTestId('specs-check-po-status').textContent).toBe('Analisando');
    expect(screen.queryByTestId('specs-check-retry')).toBeNull();
  });

  it('offers the retry when a reviewer failed on the current text, and not when both approved', () => {
    const failed = { specsHash: 'h', verdict: 'failed' as const, findings: [], reason: 'sem resposta', at: null };
    const approved = { specsHash: 'h', verdict: 'approved' as const, findings: [], reason: null, at: null };
    const first = render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: failed, sm: approved }} busy={false} onRetry={() => undefined} />);
    expect(screen.getByTestId('specs-check-retry')).toBeTruthy();
    first.unmount();
    render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: approved, sm: approved }} busy={false} onRetry={() => undefined} />);
    expect(screen.queryByTestId('specs-check-retry')).toBeNull();
  });
});
