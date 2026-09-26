import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { LoginCard, LoginControls } from './LoginCard.js';

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
    expect(screen.getByText('O login demorou demais. Tente novamente.')).toBeTruthy();
  });

  it('shows an API error when starting login fails', async () => {
    const login = vi.spyOn(api, 'login').mockRejectedValue(new Error('HTTP 500'));
    render(<LoginCard cli="claude" title="Login do Claude" item={null} onDone={noop} />);
    fireEvent.click(screen.getByText('Entrar'));
    expect(await screen.findByText('Não foi possível iniciar o login. Tente novamente.')).toBeTruthy();
    login.mockRestore();
  });
});
