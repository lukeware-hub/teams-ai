import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatApi, runApi, type ChatMessage } from '../api.js';
import { ChatPage, plainError, usageLine } from './Chat.js';

const projects = [
  { projectId: 'hello-app', name: 'Hello app', description: '', dir: '/d', specs: [] },
  { projectId: 'other', name: 'Outro', description: '', dir: '/o', specs: [] },
];
const at = '2026-10-14T10:00:00.000Z';
const page = () => render(<MemoryRouter><ChatPage /></MemoryRouter>);

afterEach(() => vi.restoreAllMocks());

describe('ChatPage', () => {
  it('asks a question, shows the answer and keeps the question until it is answered', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: [] });
    const ask = vi.spyOn(chatApi, 'ask').mockResolvedValue({ message: { role: 'assistant', text: 'Estão criando o login.', at } });
    page();
    await screen.findByText('Nenhuma pergunta feita ainda.');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'O que está sendo feito?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Estão criando o login.')).toBeTruthy();
    expect(ask).toHaveBeenCalledWith('hello-app', 'O que está sendo feito?');
    expect(screen.getByText('O que está sendo feito?')).toBeTruthy();
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the saved conversation and the correction spec the chat opened', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    const saved: ChatMessage[] = [
      { role: 'user', text: 'Tem algo fora do escopo?', at },
      { role: 'assistant', text: 'Sim, um login.', at, correction: { title: 'Login indevido', specId: 'fix-login' } },
      { role: 'assistant', text: 'Outra coisa.', at: '2026-10-14T10:01:00.000Z', correction: { title: 'Outra', error: 'sem workspace' } },
    ];
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: saved });
    page();
    expect(await screen.findByText('Sim, um login.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir para revisar e iniciar' }).getAttribute('href')).toBe('/refine/hello-app/fix-login');
    expect(screen.getByText(/Não consegui abrir a spec de correção “Outra”: sem workspace/)).toBeTruthy();
  });

  it('keeps the typed text, explains the failure in a popup and sends again on request', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: [] });
    const ask = vi.spyOn(chatApi, 'ask').mockRejectedValueOnce(new Error('internal error')).mockResolvedValueOnce({ message: { role: 'assistant', text: 'Agora foi.', at } });
    page();
    await screen.findByText('Nenhuma pergunta feita ainda.');
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: 'oi' } });
    fireEvent.keyDown(screen.getByTestId('chat-input'), { key: 'Enter' });
    const popup = await screen.findByRole('dialog', { name: 'Não consegui responder' });
    expect(popup.textContent).toContain('Algo deu errado do nosso lado');
    expect(popup.textContent).not.toContain('internal error');
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('oi');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Agora foi.')).toBeTruthy();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the server message as it is when it is already plain Portuguese, and a connection message when the server is unreachable', async () => {
    expect(plainError('O limite de uso do Claude acabou por agora.')).toBe('O limite de uso do Claude acabou por agora.');
    expect(plainError('Failed to fetch')).toContain('Não consegui falar com o Teams AI');
    expect(plainError('HTTP 502')).toContain('Algo deu errado do nosso lado');
  });

  it('loads the conversation of the chosen project and clears it after confirming', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    const messages = vi.spyOn(chatApi, 'messages').mockImplementation(async (id) => ({ messages: id === 'other' ? [{ role: 'user', text: 'pergunta do outro', at }] : [] }));
    const clear = vi.spyOn(chatApi, 'clear').mockResolvedValue({ ok: true });
    page();
    await screen.findByText('Nenhuma pergunta feita ainda.');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other' } });
    expect(await screen.findByText('pergunta do outro')).toBeTruthy();
    expect(messages).toHaveBeenLastCalledWith('other');
    fireEvent.click(screen.getByRole('button', { name: 'Limpar conversa' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Limpar' }));
    await waitFor(() => expect(screen.queryByText('pergunta do outro')).toBeNull());
    expect(clear).toHaveBeenCalledWith('other');
  });

  it('has a Nova spec shortcut for the chosen project and the example question about it', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: [] });
    const Hub = () => <output data-testid="hub">{useLocation().search}</output>;
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/projects/:projectId" element={<Hub />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Como crio uma nova spec?' }));
    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('Como crio uma nova spec?');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Nova spec' }));
    expect(screen.getByTestId('hub').textContent).toBe('?novaSpec=1');
  });

  it('shows what an answer cost under it, and nothing for an old answer saved before the cost was measured', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: [
      { role: 'assistant', text: 'Resposta nova.', at, usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheWriteTokens: 800, costUsd: 0.0421, seconds: 14, turns: 3 } },
      { role: 'assistant', text: 'Resposta antiga.', at },
    ] });
    page();
    await screen.findByText('Resposta nova.');
    expect(screen.getAllByTestId('usage')).toHaveLength(1);
    expect(screen.getByTestId('usage').textContent).toContain('Custo estimado US$ 0.0421000 · 7 000 tokens lidos · 340 escritos · 14 s');
    expect(usageLine({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, seconds: 0, turns: 1 })).toBe('10 tokens lidos · 2 escritos · menos de 1 s');
    expect(usageLine({ inputTokens: 2, outputTokens: 1572, cacheReadTokens: 0, cacheWriteTokens: 24874, costUsd: 0.0039, seconds: 8, turns: 1 })).toBe('Custo estimado US$ 0.0039000 · 24 876 tokens lidos · 1 572 escritos · 8 s');
  });

  it('brings back the earlier questions with the arrow keys, and Enter sends the one on screen', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: [
      { role: 'user', text: 'primeira', at },
      { role: 'assistant', text: 'Resposta um.', at },
      { role: 'user', text: 'segunda', at },
      { role: 'assistant', text: 'Resposta dois.', at },
    ] });
    const ask = vi.spyOn(chatApi, 'ask').mockResolvedValue({ message: { role: 'assistant', text: 'Certo.', at } });
    page();
    await screen.findByText('Resposta dois.');
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('segunda');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('primeira');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('primeira');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('segunda');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(ask).toHaveBeenCalledWith('hello-app', 'segunda'));
  });

  it('leaves a question being edited alone: arrow up recalls only from the start of the box', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: [{ role: 'user', text: 'primeira', at }] });
    page();
    await screen.findByText('primeira');
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'texto em edição' } });
    input.setSelectionRange(5, 5);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('texto em edição');
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('primeira');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('texto em edição');
  });

  it('lists each earlier question once, the newest first', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: [
      { role: 'user', text: 'repetida', at },
      { role: 'assistant', text: 'Resposta um.', at },
      { role: 'user', text: 'repetida', at },
      { role: 'assistant', text: 'Resposta dois.', at },
      { role: 'user', text: 'outra', at },
      { role: 'assistant', text: 'Resposta tres.', at },
    ] });
    page();
    await screen.findByText('Resposta tres.');
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('outra');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('repetida');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('repetida');
  });

  it('does nothing on arrow up when there is no earlier question', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue(projects as never);
    vi.spyOn(chatApi, 'messages').mockResolvedValue({ messages: [] });
    page();
    await screen.findByText('Nenhuma pergunta feita ainda.');
    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('');
  });

  it('says so when there is no project', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue([]);
    page();
    expect(await screen.findByText('Nenhum projeto para perguntar ainda.')).toBeTruthy();
  });
});
