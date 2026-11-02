import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';

describe('ConfirmDialog tone', () => {
  it('keeps the destructive look by default: a red tile with the trash icon and a red confirm', () => {
    render(<ConfirmDialog title="Excluir projeto" confirmLabel="Excluir" onConfirm={vi.fn()} onCancel={vi.fn()}>Some text</ConfirmDialog>);
    const confirm = screen.getByTestId('delete-confirm');
    expect(confirm.className).toContain('confirm-danger');
    expect(document.querySelector('.confirm-icon')!.className).not.toContain('is-accent');
  });

  it('uses the accent look for a process action: a violet tile and a primary confirm, with no danger colour', () => {
    render(<ConfirmDialog title="Reprocessar a etapa" confirmLabel="Reprocessar" tone="accent" icon="refresh" confirmTestId="stage-confirm" onConfirm={vi.fn()} onCancel={vi.fn()}>Volta ao texto entregue.</ConfirmDialog>);
    const confirm = screen.getByTestId('stage-confirm');
    expect(confirm.className).toContain('primary');
    expect(confirm.className).not.toContain('confirm-danger');
    expect(document.querySelector('.confirm-icon')!.className).toContain('is-accent');
  });

  it('keeps Shift+Tab inside the dialog when focus is on a field in it', () => {
    render(<ConfirmDialog title="Excluir" confirmLabel="Excluir" detail={<input aria-label="Nome" />} onConfirm={vi.fn()} onCancel={vi.fn()}>Texto.</ConfirmDialog>);
    screen.getByLabelText('Nome').focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('delete-confirm'));
  });

  it('confirms through the test id it was given, and cancels with the close button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog title="Reavaliar" confirmLabel="Reavaliar" tone="accent" icon="refresh" confirmTestId="reevaluate-confirm" onConfirm={onConfirm} onCancel={onCancel}>Texto.</ConfirmDialog>);
    fireEvent.click(screen.getByTestId('reevaluate-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
