import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginControls } from './LoginCard.js';

const noop = () => undefined;

describe('LoginControls', () => {
  it('shows the code field only in awaiting-code and sends the pasted code', () => {
    const onSend = vi.fn();
    const { rerender } = render(<LoginControls state={{ name: 'idle' }} code="" onCode={noop} onStart={noop} onSend={onSend} onCancel={noop} />);
    expect(screen.getByText('Entrar')).toBeTruthy();
    expect(screen.queryByTestId('code-input')).toBeNull();
    rerender(<LoginControls state={{ name: 'awaiting-browser', url: 'https://github.com/login/device', code: 'A1EB-D4E0' }} code="" onCode={noop} onStart={noop} onSend={onSend} onCancel={noop} />);
    expect(screen.getByText('Abrir link').getAttribute('href')).toBe('https://github.com/login/device');
    expect(screen.getByTestId('one-time-code').textContent).toBe('A1EB-D4E0');
    expect(screen.queryByTestId('code-input')).toBeNull();
    rerender(<LoginControls state={{ name: 'awaiting-code', url: 'https://claude.example/a' }} code="c0de#st" onCode={noop} onStart={noop} onSend={onSend} onCancel={noop} />);
    expect(screen.getByTestId('code-input')).toBeTruthy();
    fireEvent.click(screen.getByText('Enviar'));
    expect(onSend).toHaveBeenCalledTimes(1);
    rerender(<LoginControls state={{ name: 'failed', reason: 'timeout' }} code="" onCode={noop} onStart={noop} onSend={onSend} onCancel={noop} />);
    expect(screen.getByText('Tentar novamente')).toBeTruthy();
    expect(screen.getByText('timeout')).toBeTruthy();
  });
});
