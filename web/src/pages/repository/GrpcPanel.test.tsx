import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { runApi } from '../../api.js';
import { GrpcPanel } from './GrpcPanel.js';

const catalog = (source: 'reflection' | 'proto' = 'proto') => ({
  source,
  services: [
    {
      service: 'kh.policy.v1.PolicyService',
      methods: [
        { name: 'GetEffective', requestType: 'kh.policy.v1.GetRequest', responseType: 'kh.policy.v1.GetReply', template: '{\n  "id": ""\n}', streaming: false },
        { name: 'Watch', requestType: 'kh.policy.v1.GetRequest', responseType: 'kh.policy.v1.GetReply', template: '{}', streaming: true },
      ],
    },
  ],
});

const renderPanel = () => render(<GrpcPanel projectId="kayron-hub" repo="policy-registry-api" target="dind:20059" />);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GrpcPanel', () => {
  it('lists the methods with where the list came from, and filters them by the search', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    renderPanel();
    expect(await screen.findByTestId('repo-grpc-method-GetEffective')).toBeTruthy();
    expect(screen.getByTestId('repo-grpc-source').textContent).toBe('Lista lida dos arquivos .proto');
    fireEvent.change(screen.getByTestId('repo-grpc-search'), { target: { value: 'watch' } });
    expect(screen.queryByTestId('repo-grpc-method-GetEffective')).toBeNull();
    expect(screen.getByTestId('repo-grpc-method-Watch')).toBeTruthy();
  });

  it('fills the request from the template and sends it, with the headers, to the picked method', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog('reflection'));
    const call = vi.spyOn(runApi, 'grpcCall').mockResolvedValue({ ok: true, output: '{ "version": "v1" }', error: '', ms: 42 });
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    expect((screen.getByTestId('repo-grpc-body') as HTMLTextAreaElement).value).toBe('{\n  "id": ""\n}');
    fireEvent.change(screen.getByTestId('repo-grpc-body'), { target: { value: '{"id":"a"}' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Cabeçalhos' }));
    fireEvent.change(screen.getByTestId('repo-grpc-headers'), { target: { value: 'authorization: Bearer t' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Requisição' }));
    fireEvent.click(screen.getByTestId('repo-grpc-send'));
    await waitFor(() => expect(call).toHaveBeenCalledWith('kayron-hub', 'policy-registry-api', { method: 'kh.policy.v1.PolicyService/GetEffective', body: '{"id":"a"}', headers: 'authorization: Bearer t' }));
    expect((await screen.findByTestId('repo-grpc-result-state')).textContent).toBe('0 OK');
    expect(screen.getByText('42 ms · 21 B')).toBeTruthy();
    expect(screen.getByTestId('repo-grpc-result-body').textContent).toBe('{\n  "version": "v1"\n}');
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByTestId('repo-grpc-result-body').textContent).toBe('{ "version": "v1" }');
    expect(screen.getByTestId('repo-grpc-bar').textContent).toContain('dind:20059 / PolicyService / GetEffective');
  });

  it('shows a failed call with its error, and does not offer to call a streaming method', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    vi.spyOn(runApi, 'grpcCall').mockResolvedValue({ ok: false, output: '', error: 'ERROR: Code: NotFound', ms: 7 });
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    fireEvent.click(screen.getByTestId('repo-grpc-send'));
    expect((await screen.findByTestId('repo-grpc-result-state')).textContent).toBe('Erro');
    expect(screen.getByTestId('repo-grpc-result-body').textContent).toContain('Code: NotFound');
    fireEvent.click(screen.getByTestId('repo-grpc-method-Watch'));
    expect(screen.getByTestId('repo-grpc-streaming')).toBeTruthy();
    expect(screen.getByTestId('repo-grpc-send').hasAttribute('disabled')).toBe(true);
  });

  it('says why the list could not be read and tries again on the owner\'s click', async () => {
    const load = vi.spyOn(runApi, 'grpcCatalog').mockRejectedValueOnce(new Error('Failed to dial target host')).mockResolvedValueOnce(catalog());
    renderPanel();
    expect((await screen.findByTestId('repo-grpc-error')).textContent).toContain('Failed to dial target host');
    expect(screen.getByText('Se o sistema estiver parado, use Iniciar no painel do repositório.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByTestId('repo-grpc-method-GetEffective')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('marks each method as reading or maybe writing, from its name, and shows a summary until one is picked', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue({
      source: 'proto',
      services: [{ service: 'kh.policy.v1.PolicyService', methods: [{ name: 'GetEffective', requestType: 'a', responseType: 'b', template: '{}', streaming: false }, { name: 'PublishVersion', requestType: 'a', responseType: 'b', template: '{}', streaming: false }] }],
    });
    renderPanel();
    expect(await screen.findByTestId('repo-grpc-summary')).toBeTruthy();
    expect(screen.getByText('2 métodos · 1 serviço')).toBeTruthy();
    expect(screen.getByText('Comece por um método de leitura.')).toBeTruthy();
    expect(screen.getByText('PolicyService')).toBeTruthy();
    expect(screen.getByTestId('repo-grpc-method-GetEffective').textContent).toContain('Leitura');
    expect(screen.getByTestId('repo-grpc-method-PublishVersion').textContent).toContain('Pode gravar');
  });

  it('sends with Ctrl+Enter and explains an unauthenticated answer, and goes back to the list on a phone', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    const call = vi.spyOn(runApi, 'grpcCall').mockResolvedValue({ ok: false, output: '', error: 'UNAUTHENTICATED (16): UNAUTHENTICATED', ms: 24 });
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    fireEvent.keyDown(screen.getByTestId('repo-grpc-body'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect((await screen.findByTestId('repo-grpc-advice')).textContent).toContain('preencha Cabeçalhos');
    fireEvent.click(screen.getByTestId('repo-grpc-back'));
    expect(screen.getByTestId('repo-grpc-summary')).toBeTruthy();
  });

  it('restores the request from the template, fills it with examples, and formats it, and says when the JSON is invalid', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    const body = () => (screen.getByTestId('repo-grpc-body') as HTMLTextAreaElement).value;
    fireEvent.change(screen.getByTestId('repo-grpc-body'), { target: { value: '{"id":"a"' } });
    fireEvent.click(screen.getByTestId('repo-grpc-beautify'));
    expect(screen.getByTestId('repo-grpc-invalid')).toBeTruthy();
    fireEvent.change(screen.getByTestId('repo-grpc-body'), { target: { value: '{"id":"a"}' } });
    expect(screen.queryByTestId('repo-grpc-invalid')).toBeNull();
    fireEvent.click(screen.getByTestId('repo-grpc-beautify'));
    expect(body()).toBe('{\n  "id": "a"\n}');
    fireEvent.click(screen.getByTestId('repo-grpc-restore'));
    expect(body()).toBe('{\n  "id": ""\n}');
    // The gutter beside the text numbers each of the three lines.
    expect(screen.getByTestId('repo-grpc-body').parentElement?.querySelector('pre')?.textContent).toBe('1\n2\n3');
  });

  it('fills the request with example values and keeps the restore button for the empty model', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    const body = () => (screen.getByTestId('repo-grpc-body') as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByTestId('repo-grpc-example'));
    expect(JSON.parse(body())).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    fireEvent.click(screen.getByTestId('repo-grpc-restore'));
    expect(JSON.parse(body())).toEqual({ id: '' });
  });

  it('offers the project test tokens on the headers tab and puts the issued authorization in the headers', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    vi.spyOn(runApi, 'grpcTokens').mockResolvedValue([{ name: 'E2E_MAKER_TOKEN', username: 'maker' }, { name: 'E2E_CHECKER_TOKEN', username: 'checker' }]);
    const token = vi.spyOn(runApi, 'grpcToken').mockResolvedValue('authorization: Bearer abc.def');
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    fireEvent.click(screen.getByRole('tab', { name: 'Cabeçalhos' }));
    fireEvent.click(await screen.findByTestId('repo-grpc-token-checker'));
    await waitFor(() => expect(token).toHaveBeenCalledWith('kayron-hub', 'policy-registry-api', 'E2E_CHECKER_TOKEN'));
    expect((await screen.findByTestId('repo-grpc-token-note')).textContent).toBe('Token de checker aplicado.');
    expect((screen.getByTestId('repo-grpc-headers') as HTMLTextAreaElement).value).toBe('authorization: Bearer abc.def');
  });

  it('keeps Enviar disabled while a token is being issued, so a call never goes out without it', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    vi.spyOn(runApi, 'grpcTokens').mockResolvedValue([{ name: 'E2E_MAKER_TOKEN', username: 'maker' }]);
    let issue: (line: string) => void = () => undefined;
    vi.spyOn(runApi, 'grpcToken').mockReturnValue(new Promise<string>((resolve) => (issue = resolve)));
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    fireEvent.click(screen.getByRole('tab', { name: 'Cabeçalhos' }));
    fireEvent.click(await screen.findByTestId('repo-grpc-token-maker'));
    expect(screen.getByTestId('repo-grpc-send').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('repo-grpc-token-wait').textContent).toContain('Emitindo o token');
    issue('authorization: Bearer abc');
    await waitFor(() => expect(screen.getByTestId('repo-grpc-send').hasAttribute('disabled')).toBe(false));
  });

  it('says why a token could not be issued and leaves the headers alone', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    vi.spyOn(runApi, 'grpcTokens').mockResolvedValue([{ name: 'E2E_MAKER_TOKEN', username: 'maker' }]);
    vi.spyOn(runApi, 'grpcToken').mockRejectedValue(new Error('the project has no identity provider yet: deploy the project again'));
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    fireEvent.click(screen.getByRole('tab', { name: 'Cabeçalhos' }));
    fireEvent.click(await screen.findByTestId('repo-grpc-token-maker'));
    expect((await screen.findByTestId('repo-grpc-token-note')).textContent).toContain('Não foi possível emitir o token de maker: the project has no identity provider yet');
    expect((screen.getByTestId('repo-grpc-headers') as HTMLTextAreaElement).value).toBe('');
  });

  it('counts the filled headers on their tab', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue(catalog());
    renderPanel();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-GetEffective'));
    fireEvent.click(screen.getByRole('tab', { name: 'Cabeçalhos' }));
    fireEvent.change(screen.getByTestId('repo-grpc-headers'), { target: { value: 'authorization: x\n\nx-tenant: y' } });
    expect(screen.getByRole('tab', { name: /^Cabeçalhoss*2$/ })).toBeTruthy();
  });

  it('treats an answer that is not a catalog as a failure instead of breaking the page', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue({} as never);
    renderPanel();
    expect((await screen.findByTestId('repo-grpc-error')).textContent).toContain('resposta inesperada do servidor');
  });

  it('says the service publishes no methods', async () => {
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue({ source: 'reflection', services: [] });
    renderPanel();
    expect(await screen.findByTestId('repo-grpc-empty')).toBeTruthy();
  });
});
