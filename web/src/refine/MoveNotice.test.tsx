import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MoveRow } from '../api.js';
import { MoveNotice } from './MoveNotice.js';

const move = (over: Partial<MoveRow> = {}): MoveRow => ({ moveId: 'move-po-c1-0', role: 'po', cycle: 1, from: 'design.md', to: 'flow.md', reason: 'ordem de passos', quote: 'Valide.', text: 'Valide.', status: 'applied', ...over });
const names = (file: string) => file;

describe('MoveNotice', () => {
  it('shows the newest applied move, with both documents and its reason', () => {
    const older = move({ moveId: 'move-sm-c1-0', from: 'project.md', to: 'stack.md', reason: 'tecnologia' });
    const newest = move({ moveId: 'move-po-c2-0', from: 'design.md', to: 'flow.md', reason: 'ordem de passos' });
    render(<MoveNotice moves={[older, newest]} onUndo={vi.fn()} onClose={vi.fn()} docName={names} />);
    const notice = screen.getByTestId('move-notice');
    expect(notice.textContent).toContain('Movi um trecho de design.md para flow.md');
    expect(notice.textContent).toContain('ordem de passos');
    expect(notice.textContent).not.toContain('stack.md');
  });

  it('undoes the newest move by its id', () => {
    const onUndo = vi.fn();
    render(<MoveNotice moves={[move()]} onUndo={onUndo} onClose={vi.fn()} docName={names} />);
    fireEvent.click(screen.getByTestId('undo-move'));
    expect(onUndo).toHaveBeenCalledWith('move-po-c1-0');
  });

  it('closes the newest move by its id', () => {
    const onClose = vi.fn();
    render(<MoveNotice moves={[move()]} onUndo={vi.fn()} onClose={onClose} docName={names} />);
    fireEvent.click(screen.getByTestId('close-move-notice'));
    expect(onClose).toHaveBeenCalledWith('move-po-c1-0');
  });

  it('hides a move closed for good, and shows the next applied move when one comes', () => {
    const closed = move({ closed: true });
    const { rerender } = render(<MoveNotice moves={[closed]} onUndo={vi.fn()} onClose={vi.fn()} docName={names} />);
    expect(screen.queryByTestId('move-notice')).toBeNull();
    rerender(<MoveNotice moves={[closed, move({ moveId: 'move-sm-c2-0', from: 'project.md', to: 'stack.md' })]} onUndo={vi.fn()} onClose={vi.fn()} docName={names} />);
    expect(screen.getByTestId('move-notice').textContent).toContain('project.md para stack.md');
  });

  it('shows nothing without an applied move, such as when the only one was undone', () => {
    render(<MoveNotice moves={[move({ status: 'undone' })]} onUndo={vi.fn()} onClose={vi.fn()} docName={names} />);
    expect(screen.queryByTestId('move-notice')).toBeNull();
  });
});
