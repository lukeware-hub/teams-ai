import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { GrpcCallResult, GrpcCatalog, GrpcMethod } from '@server/grpc/grpc.js';
import { runApi } from '../../api.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Icon } from '../../components/Icons.js';
import { InfoTip } from '../../components/InfoTip.js';
import { useMediaQuery } from '../../useMediaQuery.js';
import { action, panel, sectionHeading, sectionTitle } from '../project-shared.js';
import type { TokenChoice } from '@server/grpc/token.js';
import { adviceFor, exampleOf, isRead, prettyJson, shortService, statusOf, tokenExpiry, withAuthorization } from './grpc-hints.js';
import { JsonEditor } from './JsonEditor.js';

interface Picked {
  service: string;
  method: GrpcMethod;
}
/** What the workbench shows: the request, its headers, or (on a phone, where it does not fit below) the response. */
type Pane = 'body' | 'headers' | 'response';

const SOURCE_LABEL: Record<GrpcCatalog['source'], string> = { proto: 'Lista lida dos arquivos .proto', reflection: 'Lista lida do serviço' };
const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'erro desconhecido');
const bytesOf = (text: string) => new TextEncoder().encode(text).length;
// The global button width of 9rem would make every small control here a wide block.
const tab = (on: boolean) => `${action.plain} h-9 min-w-0 px-3 ${on ? 'border-accent-line bg-accent-soft text-accent-text' : 'border-transparent bg-transparent text-ink-soft'}`;
const tool = `${action.plain} h-8 min-w-0 border-line bg-transparent px-2 text-ink-soft`;

function MethodChip({ name }: { name: string }) {
  return isRead(name) ? <span className="status-pill tone-good">Leitura</span> : <span className="status-pill tone-warn">Pode gravar</span>;
}

/** The gRPC methods of the repository's deployed service as a request workbench: pick a method, edit the request, send it, read the response. */
export function GrpcPanel({ projectId, repo, target }: { projectId: string; repo: string; target: string }) {
  const phone = useMediaQuery('(max-width: 767px)');
  const [catalog, setCatalog] = useState<GrpcCatalog | null | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [body, setBody] = useState('');
  const [headers, setHeaders] = useState('');
  const [pane, setPane] = useState<Pane>('body');
  const [invalid, setInvalid] = useState(false);
  const [raw, setRaw] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<GrpcCallResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [tokens, setTokens] = useState<TokenChoice[]>([]);
  const [minting, setMinting] = useState<string | null>(null);
  const [tokenNote, setTokenNote] = useState<{ ok: boolean; text: string } | null>(null);

  // The test identities the project can sign a token for; without any, the headers tab has no token buttons.
  useEffect(() => {
    runApi.grpcTokens(projectId, repo).then(setTokens, () => setTokens([]));
  }, [projectId, repo]);

  const useToken = async (choice: TokenChoice) => {
    setMinting(choice.name);
    setTokenNote(null);
    await runApi
      .grpcToken(projectId, repo, choice.name)
      .then(
        (line) => {
          setHeaders((current) => withAuthorization(current, line));
          const until = tokenExpiry(line);
          setTokenNote({ ok: true, text: `Token de ${choice.username} aplicado${until ? `. Vale até ${until.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}.` });
        },
        (e) => setTokenNote({ ok: false, text: `Não foi possível emitir o token de ${choice.username}: ${messageOf(e)}` }),
      );
    setMinting(null);
  };

  const load = useCallback(() => {
    setCatalog(undefined);
    setFailure(null);
    runApi
      .grpcCatalog(projectId, repo)
      .then((c) => (Array.isArray(c.services) ? setCatalog(c) : Promise.reject(new Error('resposta inesperada do servidor'))))
      .catch((e) => {
        setCatalog(null);
        setFailure(messageOf(e));
      });
  }, [projectId, repo]);
  useEffect(load, [load]);

  const pick = (next: Picked | null) => {
    setPicked(next);
    setBody(next?.method.template ?? '');
    setPane('body');
    setInvalid(false);
    setResult(null);
  };
  const edit = (text: string) => {
    setBody(text);
    setInvalid(false);
  };
  const beautify = () => {
    try {
      setBody(JSON.stringify(JSON.parse(body), null, 2));
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  };
  const send = async () => {
    if (!picked || picked.method.streaming || sending) return;
    setSending(true);
    setResult(null);
    if (phone) setPane('response');
    await runApi
      .grpcCall(projectId, repo, { method: `${picked.service}/${picked.method.name}`, body, headers })
      .then(setResult, (e) => setResult({ ok: false, output: '', error: messageOf(e), ms: 0 }));
    setSending(false);
  };
  const sendOnCtrlEnter = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void send();
  };
  const shownText = result ? [result.output && (raw ? result.output : prettyJson(result.output)), result.error].filter(Boolean).join('\n') : '';
  const copy = () => {
    navigator.clipboard?.writeText(shownText).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog?.services ?? []).map((s) => ({ ...s, methods: s.methods.filter((m) => !q || `${s.service}/${m.name}`.toLowerCase().includes(q)) })).filter((s) => s.methods.length > 0);
  }, [catalog, query]);
  const total = catalog?.services.reduce((n, s) => n + s.methods.length, 0) ?? 0;
  const advice = result && !result.ok ? adviceFor(result.error) : null;
  const headerCount = headers.split('\n').filter((l) => l.trim()).length;

  return (
    <section className={`${panel} max-md:px-3`} data-testid="repo-grpc">
      {catalog === undefined && <p data-testid="repo-grpc-loading" className="hint m-0" role="status">Lendo os métodos do serviço…</p>}
      {catalog === null && (
        <div data-testid="repo-grpc-error" role="alert" className="grid justify-items-start gap-2">
          <p className="m-0 rounded px-1 text-[0.875rem] tone-bad">Não foi possível ler os métodos: {failure}</p>
          <p className="hint m-0">Se o sistema estiver parado, use Iniciar no painel do repositório.</p>
          <button type="button" className={action.secondary} onClick={load}>Tentar de novo</button>
        </div>
      )}
      {catalog && catalog.services.length === 0 && <p data-testid="repo-grpc-empty" className="hint m-0">Este serviço não publica métodos.</p>}
      {catalog && catalog.services.length > 0 && (
        <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
          <div className={`grid min-w-0 content-start gap-3 ${picked ? 'max-md:hidden' : ''}`} data-testid="repo-grpc-methods">
            <div className={sectionTitle}>
              <h2 data-testid="repo-grpc-heading" className={sectionHeading}>{`Métodos · ${total}`}</h2>
              <InfoTip label="Métodos" text="Lidos do serviço. O chip Leitura ou Pode gravar é uma dica tirada do nome do método, não uma garantia." />
            </div>
            <span data-testid="repo-grpc-source" className="hint -mt-2 text-[0.8125rem]">{SOURCE_LABEL[catalog.source]}</span>
            <input data-testid="repo-grpc-search" className="w-full min-w-0 appearance-none" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar método" aria-label="Buscar método" />
            {shown.length === 0 && <p className="hint m-0">Nenhum método encontrado.</p>}
            {shown.map((s) => (
              <div key={s.service} className="grid gap-1">
                <h3 className="m-0 px-1 text-[0.8125rem] font-semibold wrap-anywhere text-ink-soft" title={s.service}>{shortService(s.service)}</h3>
                {s.methods.map((m) => {
                  const active = picked?.service === s.service && picked.method.name === m.name;
                  return (
                    <button
                      type="button"
                      key={m.name}
                      data-testid={`repo-grpc-method-${m.name}`}
                      className={`${action.plain} h-11 ${active ? 'border-accent-line bg-accent-soft text-accent-text' : 'border-line bg-transparent text-ink hover:bg-surface-muted'}`}
                      aria-pressed={active}
                      onClick={() => pick({ service: s.service, method: m })}
                    >
                      <span className="flex w-full min-w-0 items-center justify-between gap-2">
                        <span className="min-w-0 truncate">{m.name}</span>
                        {m.streaming ? <span className="count-pill">Fluxo</span> : <MethodChip name={m.name} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className={`grid min-w-0 content-start gap-3 ${picked ? '' : 'max-md:hidden'}`} data-testid="repo-grpc-editor">
            {!picked ? (
              <div data-testid="repo-grpc-summary" className="grid content-start gap-1 rounded-lg border border-line bg-surface-muted p-5">
                <strong className="text-[0.9375rem]">{`${total} ${total === 1 ? 'método' : 'métodos'} · ${catalog.services.length} ${catalog.services.length === 1 ? 'serviço' : 'serviços'}`}</strong>
                <span className="hint text-[0.8125rem]">destino {target}</span>
                <span className="mt-2 text-[0.875rem]">Comece por um método de leitura.</span>
              </div>
            ) : (
              <>
                <div data-testid="repo-grpc-bar" className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-muted p-2 max-md:sticky max-md:top-0 max-md:z-10">
                  <button type="button" className={`${action.plain} h-9 w-9 min-w-0 flex-none border-transparent bg-transparent p-0 text-accent-text md:hidden`} onClick={() => pick(null)} data-testid="repo-grpc-back" aria-label="Voltar para os métodos">
                    <Icon name="arrow-left" size={20} />
                  </button>
                  <span className="count-pill max-md:hidden">gRPC</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]" title={`${target}/${picked.service}/${picked.method.name}`}>
                    <span className="max-md:hidden">{target} / {shortService(picked.service)} / </span>
                    <strong data-testid="repo-grpc-picked">{picked.method.name}</strong>
                  </span>
                  {picked.method.streaming ? <span className="count-pill">Fluxo</span> : <MethodChip name={picked.method.name} />}
                  <ActionButton className="primary-button h-9 w-auto min-w-0 flex-none px-4" data-testid="repo-grpc-send" busy={sending} disabled={picked.method.streaming || minting !== null} onClick={send}>Enviar</ActionButton>
                </div>
                <div className="hint grid gap-0.5 text-[0.8125rem] wrap-anywhere max-md:hidden md:flex md:flex-wrap md:gap-x-3">
                  <span>{picked.service}</span>
                  <span>entrada {picked.method.requestType}</span>
                  <span>saída {picked.method.responseType}</span>
                </div>
                {picked.method.streaming ? (
                  <p data-testid="repo-grpc-streaming" className="hint m-0">Chamadas com fluxo contínuo não são suportadas aqui.</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-1">
                      <div role="tablist" aria-label="Partes da chamada" className="flex gap-1">
                        <button type="button" role="tab" aria-selected={pane === 'body'} className={tab(pane === 'body')} onClick={() => setPane('body')}>Requisição</button>
                        <button type="button" role="tab" aria-selected={pane === 'headers'} className={tab(pane === 'headers')} onClick={() => setPane('headers')}>
                          Cabeçalhos{headerCount > 0 && <span className="count-pill">{headerCount}</span>}
                        </button>
                        <button type="button" role="tab" aria-selected={pane === 'response'} className={`${tab(pane === 'response')} md:hidden`} onClick={() => setPane('response')}>Resposta</button>
                      </div>
                      {pane === 'body' && (
                        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                          {invalid && <span data-testid="repo-grpc-invalid" role="alert" className="text-[0.8125rem] tone-bad rounded px-1">JSON inválido</span>}
                          <button type="button" className={tool} onClick={() => edit(picked.method.template)} data-testid="repo-grpc-restore" title="Volta ao modelo do .proto, com os campos vazios">
                            <Icon name="refresh" size={14} />
                            Restaurar modelo
                          </button>
                          <button type="button" className={tool} onClick={() => edit(exampleOf(picked.method.template))} data-testid="repo-grpc-example" title="Preenche os campos com valores de exemplo">Exemplo</button>
                          <button type="button" className={tool} onClick={beautify} data-testid="repo-grpc-beautify">Embelezar</button>
                        </div>
                      )}
                    </div>
                    <div className={`grid gap-2 ${pane === 'response' ? 'max-md:hidden' : ''}`} data-testid="repo-grpc-request">
                      {pane === 'headers' ? (
                        <>
                          {tokens.length > 0 && (
                            <div data-testid="repo-grpc-tokens" className="flex flex-wrap items-center gap-2">
                              <span className="hint text-[0.8125rem]">Token de teste do projeto</span>
                              {tokens.map((t) => (
                                <ActionButton key={t.name} className={`${tool} text-ink`} data-testid={`repo-grpc-token-${t.username}`} busy={minting === t.name} disabled={minting !== null} onClick={() => useToken(t)}>
                                  {t.username}
                                </ActionButton>
                              ))}
                            </div>
                          )}
                          {minting !== null && <span data-testid="repo-grpc-token-wait" role="status" className="hint text-[0.8125rem]">Emitindo o token no provedor de identidade do projeto…</span>}
                          {tokenNote && <span data-testid="repo-grpc-token-note" role={tokenNote.ok ? 'status' : 'alert'} className={`text-[0.8125rem] ${tokenNote.ok ? 'hint' : 'tone-bad rounded px-1'}`}>{tokenNote.text}</span>}
                          <JsonEditor testId="repo-grpc-headers" label="Cabeçalhos" value={headers} onChange={setHeaders} onKeyDown={sendOnCtrlEnter} placeholder="authorization: Bearer …" />
                          <span className="hint text-[0.8125rem]">Opcional, um por linha, nome: valor. Nada é guardado.</span>
                        </>
                      ) : (
                        <JsonEditor testId="repo-grpc-body" label="Requisição em JSON" value={body} onChange={edit} onKeyDown={sendOnCtrlEnter} />
                      )}
                      <span className="hint text-[0.8125rem]">Ctrl+Enter envia. Chama o serviço que está rodando: um método que grava, grava.</span>
                    </div>
                    <div className={`grid gap-2 md:border-t md:border-line md:pt-3 ${pane === 'response' ? '' : 'max-md:hidden'}`} data-testid="repo-grpc-response">
                      {!result && <p className="hint m-0">{sending ? 'Enviando…' : 'A resposta aparece aqui.'}</p>}
                      {result && (
                        <div data-testid="repo-grpc-result" className="grid gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <strong className="text-[0.875rem] max-md:hidden">Resposta</strong>
                            <span data-testid="repo-grpc-result-state" className={`status-pill tone-${result.ok ? 'good' : 'bad'}`}>{statusOf(result)}</span>
                            <span className="hint text-[0.8125rem]">{result.ms} ms · {bytesOf(shownText)} B</span>
                            <div className="ml-auto flex items-center gap-1">
                              <div role="group" aria-label="Formato" className="flex gap-1">
                                <button type="button" aria-pressed={!raw} className={`${tab(!raw)} h-8`} onClick={() => setRaw(false)}>Pretty</button>
                                <button type="button" aria-pressed={raw} className={`${tab(raw)} h-8`} onClick={() => setRaw(true)}>Raw</button>
                              </div>
                              <button type="button" className={tool} onClick={copy} data-testid="repo-grpc-copy" aria-label="Copiar a resposta">
                                <Icon name={copied ? 'check' : 'copy'} size={14} />
                                <span className="max-md:hidden">{copied ? 'Copiado' : 'Copiar'}</span>
                              </button>
                            </div>
                          </div>
                          <div className={`grid min-w-0 gap-3 ${advice ? 'md:grid-cols-[minmax(0,1fr)_16rem]' : ''}`}>
                            <pre data-testid="repo-grpc-result-body" className="m-0 max-h-96 min-h-24 overflow-auto rounded-lg border border-line bg-surface-sunken p-3 font-mono text-[0.8125rem] wrap-anywhere whitespace-pre-wrap">{shownText || '(vazio)'}</pre>
                            {advice && (
                              <div data-testid="repo-grpc-advice" className="grid content-start gap-1 rounded-lg border border-line bg-surface-muted p-3 text-left text-[0.875rem] hyphens-none">
                                <strong>Orientação</strong>
                                <span>{advice}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
