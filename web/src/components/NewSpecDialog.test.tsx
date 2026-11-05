import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { refineApi } from '../api.js';
import { NewSpecDialog } from './NewSpecDialog.js';

const Where = () => <output data-testid="where">{useLocation().pathname}</output>;
const show = (onClose = vi.fn(), openRequest?: string) =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="*" element={<><NewSpecDialog projectId="hello-word" openRequest={openRequest} onClose={onClose} /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => vi.restoreAllMocks());

describe('NewSpecDialog', () => {
  it('focuses the description field when it opens', () => {
    show();
    expect(document.activeElement).toBe(screen.getByTestId('new-spec-description'));
  });
  it('keeps Criar spec disabled until there is a description', () => {
    show();
    expect((screen.getByTestId('new-spec') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'Exportar PDF' } });
    expect((screen.getByTestId('new-spec') as HTMLButtonElement).disabled).toBe(false);
  });
  it('sends the description and opens the refinement screen', async () => {
    const request = vi.spyOn(refineApi, 'request').mockResolvedValue({ sessionId: 'hello-word/hello-word-pedido-1' });
    show();
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: '  Exportar PDF  ' } });
    fireEvent.click(screen.getByTestId('new-spec'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/refine/hello-word/hello-word-pedido-1'));
    expect(request).toHaveBeenCalledWith('hello-word', 'Exportar PDF');
  });
  it('shows the error inside the modal and keeps the text', async () => {
    vi.spyOn(refineApi, 'request').mockRejectedValue(new Error('Falhou ao criar'));
    show();
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'Exportar PDF' } });
    fireEvent.click(screen.getByTestId('new-spec'));
    expect((await screen.findByTestId('new-spec-error')).textContent).toBe('Falhou ao criar');
    expect((screen.getByTestId('new-spec-description') as HTMLTextAreaElement).value).toBe('Exportar PDF');
  });
  it('closes at once when empty and asks before discarding typed text', () => {
    const onClose = vi.fn();
    show(onClose);
    fireEvent.click(screen.getByTestId('cancel-new-spec'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'texto' } });
    fireEvent.click(screen.getByTestId('cancel-new-spec'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('discard-new-spec'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('leads to the open request instead of the form', () => {
    show(vi.fn(), 'hello-word-pedido-1');
    expect(screen.queryByTestId('new-spec-description')).toBeNull();
    expect(screen.getByTestId('continue-open-request').getAttribute('href')).toBe('/refine/hello-word/hello-word-pedido-1');
  });
});
