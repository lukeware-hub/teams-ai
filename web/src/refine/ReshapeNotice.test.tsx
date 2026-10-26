import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReshapeRow } from '../api.js';
import { ReshapeNotice } from './ReshapeNotice.js';

const reshape = (over: Partial<ReshapeRow> = {}): ReshapeRow => ({ reshapeId: 'reshape-c1', file: 'briefing.md', cycle: 1, role: 'po', status: 'applied', ...over });
const names = (file: string) => file;

describe('ReshapeNotice', () => {
  it('shows the newest applied reshape, with the document it rewrote', () => {
    render(<ReshapeNotice reshapes={[reshape({ reshapeId: 'reshape-c0', file: 'project.md' }), reshape()]} onUndo={vi.fn()} onClose={vi.fn()} docName={names} />);
    const notice = screen.getByTestId('reshape-notice');
    expect(notice.textContent).toContain('Reorganizei briefing.md no modelo');
    expect(notice.textContent).not.toContain('project.md');
  });

  it('undoes the newest reshape by its id', () => {
    const onUndo = vi.fn();
    render(<ReshapeNotice reshapes={[reshape()]} onUndo={onUndo} onClose={vi.fn()} docName={names} />);
    fireEvent.click(screen.getByTestId('undo-reshape'));
    expect(onUndo).toHaveBeenCalledWith('reshape-c1');
  });

  it('closes the newest reshape by its id', () => {
    const onClose = vi.fn();
    render(<ReshapeNotice reshapes={[reshape()]} onUndo={vi.fn()} onClose={onClose} docName={names} />);
    fireEvent.click(screen.getByTestId('close-reshape-notice'));
    expect(onClose).toHaveBeenCalledWith('reshape-c1');
  });

  it('hides a reshape closed for good', () => {
    render(<ReshapeNotice reshapes={[reshape({ closed: true })]} onUndo={vi.fn()} onClose={vi.fn()} docName={names} />);
    expect(screen.queryByTestId('reshape-notice')).toBeNull();
  });

  it('shows nothing without an applied reshape, such as when the only one was undone', () => {
    render(<ReshapeNotice reshapes={[reshape({ status: 'undone' })]} onUndo={vi.fn()} onClose={vi.fn()} docName={names} />);
    expect(screen.queryByTestId('reshape-notice')).toBeNull();
  });
});
