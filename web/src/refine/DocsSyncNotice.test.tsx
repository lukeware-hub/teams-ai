import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocsSyncNotice } from './DocsSyncNotice.js';

describe('DocsSyncNotice', () => {
  it('renders nothing for a session that is not a documentation repository', () => {
    const { container } = render(<DocsSyncNotice docsSync={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when every change is published and no failure is left', () => {
    const { container } = render(<DocsSyncNotice docsSync={{ pending: 0, lastError: null, refused: false }} />);
    expect(container.textContent).toBe('');
  });

  it('shows one pending change in the singular', () => {
    render(<DocsSyncNotice docsSync={{ pending: 1, lastError: null, refused: false }} />);
    expect(screen.getByTestId('docs-sync-notice').getAttribute('data-state')).toBe('pending');
    expect(screen.getByTestId('docs-sync-notice').textContent).toBe('1 alteração espera publicação no repositório de documentos.');
  });

  it('shows the count of pending changes in the plural', () => {
    render(<DocsSyncNotice docsSync={{ pending: 3, lastError: null, refused: false }} />);
    expect(screen.getByTestId('docs-sync-notice').textContent).toBe('3 alterações esperam publicação no repositório de documentos.');
  });

  it('shows a failure in plain words, without the store text', () => {
    render(<DocsSyncNotice docsSync={{ pending: 1, lastError: 'GitHub could not be reached, so the documents were not published. They stay in the local store.', refused: false }} />);
    const notice = screen.getByTestId('docs-sync-notice');
    expect(notice.getAttribute('data-state')).toBe('error');
    expect(notice.textContent).toBe('Os documentos não foram publicados. Eles seguem salvos neste computador e a publicação tenta de novo.');
  });

  it('keeps the refusal of the store as it is, since it already names its documents in Portuguese', () => {
    const lastError = 'Não publicado: o documento docs/stack.md mudou na loja; os outros foram publicados.';
    render(<DocsSyncNotice docsSync={{ pending: 0, lastError, refused: true }} />);
    expect(screen.getByTestId('docs-sync-notice').textContent).toBe(lastError);
  });

  it('shows the generic line for a failure that is not a refusal, even when its text starts like one', () => {
    const lastError = 'Não publicado: texto que não veio da loja.';
    render(<DocsSyncNotice docsSync={{ pending: 0, lastError, refused: false }} />);
    expect(screen.getByTestId('docs-sync-notice').textContent).toBe('Os documentos não foram publicados. Eles seguem salvos neste computador e a publicação tenta de novo.');
  });

  it('stays quiet on a first failure the team retries by itself, and tells the owner once it repeats', () => {
    const { container, rerender } = render(<DocsSyncNotice docsSync={{ pending: 1, lastError: 'GitHub could not be reached', refused: false, failures: 1 }} />);
    expect(container.textContent).toBe('');
    rerender(<DocsSyncNotice docsSync={{ pending: 1, lastError: 'GitHub could not be reached', refused: false, failures: 3 }} />);
    expect(screen.getByTestId('docs-sync-notice').getAttribute('data-state')).toBe('error');
  });

  it('always shows a refusal, since the owner has to look at that document', () => {
    render(<DocsSyncNotice docsSync={{ pending: 0, lastError: 'Não publicado: o documento stack.md mudou na loja', refused: true, failures: 0 }} />);
    expect(screen.getByTestId('docs-sync-notice')).toBeTruthy();
  });
});
