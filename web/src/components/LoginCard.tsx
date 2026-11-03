import { useEffect, useState } from 'react';
import { api, type Cli, type Item, type SessionState } from '../api.js';
import { CLAUDE_LOGIN, GH_LOGIN } from '../onboarding/stepCopy.js';
import { ItemCard } from './ItemCard.js';
import { ActionButton } from './ActionButton.js';
import { Icon } from './Icons.js';
import { safeHttpUrl } from '../safeUrl.js';
import { useSse } from '../useSse.js';

const LOGIN_INFO: Record<Cli, string> = {
  gh: 'O GitHub CLI (gh) é a ferramenta de linha de comando que o Teams AI usa para criar repositórios e pull requests. Este login também lista as organizações da sua conta.',
  claude: 'Os agentes que refinam, programam e testam suas demandas rodam no Claude Code. Este login conecta a sua conta do Claude a este computador.',
};

function friendlyLoginReason(reason: string) {
  const normalized = reason.trim().toLowerCase();
  if (normalized.includes('cancel')) return 'Login cancelado. Você pode tentar novamente.';
  if (normalized.includes('timeout')) return 'O login demorou demais. Tente novamente.';
  return 'Não foi possível concluir o login. Tente novamente.';
}

export function LoginCard({ cli, title, item, onDone }: { cli: Cli; title: string; item: Item | null; onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const { state, output, setState } = useSse(url);
  const [code, setCode] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = cli === 'claude' ? CLAUDE_LOGIN : GH_LOGIN;
  const start = async () => {
    setError(null);
    try {
      const r = await api.login(cli);
      setCode('');
      if (r.state.name === 'done') {
        setUrl(null);
        onDone();
        return;
      }
      setState(r.state);
      setUrl(api.events(cli));
    } catch {
      setError('Não foi possível iniciar o login. Tente novamente.');
    }
  };
  const send = async () => {
    setError(null);
    try {
      await api.code(cli, code);
      setCode('');
    } catch {
      setError('Não foi possível enviar o código. Confira o código e tente novamente.');
    }
  };
  useEffect(() => {
    if (state.name !== 'done' || !url) return;
    setUrl(null);
    onDone();
  }, [onDone, state.name, url]);
  return (
    <ItemCard title={title} item={item} variant="login" subtitle={cli === 'claude' ? 'Conecte sua conta do Claude para os agentes de IA trabalharem.' : 'Conecte sua conta do GitHub para usar seus repositórios.'} info={LOGIN_INFO[cli]} icon={cli === 'claude' ? 'claude' : 'github'} illustration={cli === 'claude' ? '/onboarding-claude.png' : '/onboarding-github-login.png'} benefits={copy.benefits} panel={copy.panel}>
      {/* Already logged in and no login running: reconnect with the same or another account. */}
      {item?.ok && !url ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2" data-testid="reconnect">
          <p data-testid="login-card-reconnect-text" className="m-0 text-[0.875rem] text-ink-soft">
            {cli === 'claude'
              ? 'Quer usar outra conta do Claude? Entre de novo: a nova conta passa a ser a usada pelos agentes.'
              : 'Quer usar outra conta do GitHub? Entre de novo: a nova conta passa a ser a usada neste computador.'}
          </p>
          <ActionButton className="secondary" onClick={start} icon={<Icon name="refresh" size={16} />}>Reconectar</ActionButton>
        </div>
      ) : <LoginControls state={state} code={code} onCode={setCode} onStart={start} onSend={send} onCancel={() => api.cancel(cli)} />}
      {error ? <p data-testid="login-card-error" className="error">{error}</p> : null}
      {url ? (
        <button data-testid="login-card-output-toggle" type="button" className="link mt-[1.1rem] flex h-auto gap-[0.45rem] w-full items-center justify-between rounded-none border-0 border-t border-line bg-transparent px-0 pt-4 pb-[0.15rem] text-[0.8125rem] text-ink-soft enabled:hover:text-accent-text [&>svg]:text-ink-soft" aria-expanded={showOutput} onClick={() => setShowOutput((v) => !v)}>
          <span data-testid="login-card-output-toggle-label" className="inline-flex items-center gap-[0.7rem]">{showOutput ? 'Ocultar saída do CLI' : 'Mostrar saída do CLI'}</span>
          <Icon name="chevron" size={16} />
        </button>
      ) : null}
      {showOutput ? (
        <div data-testid="login-card-output" className="mt-[0.7rem] overflow-hidden rounded-lg border border-term-line bg-term-bg">
          <div data-testid="login-card-output-header" className="flex items-center justify-between border-b border-term-line px-3 py-[0.55rem] text-[0.7rem] font-bold text-term-ink-soft"><span data-testid="login-card-output-title">Saída do CLI</span><span data-testid="login-card-output-live" className="text-term-good">ao vivo</span></div>
          <pre data-testid="login-card-output-pre" className="output m-0 max-h-72 rounded-none">{output}</pre>
        </div>
      ) : null}
    </ItemCard>
  );
}

export function LoginControls({ state, code, onCode, onStart, onSend, onCancel }: { state: SessionState; code: string; onCode: (v: string) => void; onStart: () => unknown; onSend: () => unknown; onCancel: () => unknown }) {
  const live = state.name === 'starting' || state.name === 'awaiting-browser' || state.name === 'awaiting-code' || state.name === 'verifying';
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyCode = (value: string | null) => {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
    setCopied(true);
  };
  return (
    <div data-testid="login-card-controls" className="controls grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-3 @max-[40rem]:grid-cols-[minmax(0,1fr)_auto]">
      {!live ? (
        <ActionButton className="primary-button col-3 justify-self-end" onClick={onStart} icon={<Icon name={state.name === 'failed' ? 'refresh' : 'arrow-right'} size={16} />}>
          {state.name === 'failed' ? 'Tentar novamente' : 'Entrar'}
        </ActionButton>
      ) : null}
      {state.name === 'starting' || state.name === 'verifying' ? <span data-testid="login-card-status">{state.name === 'starting' ? 'Iniciando…' : 'Verificando…'}</span> : null}
      {state.name === 'awaiting-browser' || state.name === 'awaiting-code' ? (
        <div data-testid="login-card-code-area" className="col-1 row-1 flex min-w-0 flex-wrap items-center gap-[0.7rem]">
          {safeHttpUrl(state.url) ? (
            <a data-testid="login-card-open-link" className="link-button" href={safeHttpUrl(state.url)} target="_blank" rel="noreferrer">
              Abrir link
              <Icon name="external" size={16} />
            </a>
          ) : null}
          {state.name === 'awaiting-browser' && state.code ? (
            <p data-testid="login-card-code-hint" className="m-0 inline-flex flex-wrap items-center gap-[0.55rem] text-[0.875rem] leading-[1.35] text-ink-soft">
              Digite este código na página:{' '}
              <span data-testid="login-card-code-row" className="inline-flex items-center gap-[0.6rem]">
                <button data-testid="login-card-copy-code" type="button" className="relative inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-accent-line bg-accent-soft px-[0.7rem] py-[0.3rem] text-accent-ink hover:bg-accent-line [&_svg]:text-ink-soft" aria-label="Copiar código" onClick={() => copyCode(state.code)}>
                  <code className="text-[0.9375rem] font-bold tracking-[0.045em]" data-testid="one-time-code">{state.code}</code>
                  <Icon name="copy" size={16} />
                </button>
                {copied ? <span data-testid="login-card-copied" className="text-[0.8125rem] font-semibold whitespace-nowrap text-accent-text">Copiado!</span> : null}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
      {state.name === 'awaiting-code' ? (
        <form data-testid="login-card-code-form"
          className="col-2 row-1 m-0 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-[0.7rem] @max-[40rem]:col-span-full @max-[40rem]:row-2 @max-[40rem]:grid-cols-[minmax(0,1fr)]"
          onSubmit={(e) => {
            e.preventDefault();
            setSending(true);
            void Promise.resolve(onSend()).finally(() => setSending(false));
          }}
        >
          <label data-testid="login-card-code-field" className="grid min-w-0 gap-[0.38rem] text-[0.8125rem] font-semibold text-ink-soft">
            <span data-testid="login-card-code-field-label">Cole o código mostrado pela página</span>
            <input className="h-11 w-full min-w-0 text-[1rem]" data-testid="code-input" value={code} onChange={(e) => onCode(e.target.value)} placeholder="Cole o código aqui…" autoComplete="off" />
          </label>
          <ActionButton type="submit" className="primary-button @max-[40rem]:w-full" busy={sending} disabled={code.trim() === ''} icon={<Icon name="send" size={16} />}>
            Enviar
          </ActionButton>
        </form>
      ) : null}
      {live ? (
        <ActionButton className="secondary col-3 row-1 min-w-0 @max-[40rem]:col-2" aria-label="Cancelar" onClick={onCancel} icon={<Icon name="close" size={16} />} />
      ) : null}
      {state.name === 'failed' ? <p data-testid="login-card-failed" className="error col-span-full row-2 w-full">{friendlyLoginReason(state.reason)}</p> : null}
    </div>
  );
}
