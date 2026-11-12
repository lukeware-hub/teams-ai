import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StartMissingAlert } from './StartMissingAlert.js';

describe('StartMissingAlert', () => {
  it('lets the agents resolve with one button when they may decide', () => {
    const onResolve = vi.fn();
    render(<StartMissingAlert items={['Falta X.']} agentsDecide onResolve={onResolve} />);
    expect(screen.getByTestId('start-missing-agents').textContent).toContain('os agentes');
    fireEvent.click(screen.getByTestId('start-missing-resolve'));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it('tells the owner it is theirs when the agents may not decide', () => {
    render(<StartMissingAlert items={['Falta X.']} agentsDecide={false} onResolve={vi.fn()} />);
    expect(screen.getByTestId('start-missing-owner').textContent).toContain('você');
    expect(screen.queryByTestId('start-missing-resolve')).toBeNull();
  });

  it('shows only the list while the setting is unknown', () => {
    render(<StartMissingAlert items={['Falta X.']} />);
    expect(screen.queryByTestId('start-missing-agents')).toBeNull();
    expect(screen.queryByTestId('start-missing-owner')).toBeNull();
  });
});
