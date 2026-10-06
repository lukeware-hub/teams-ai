import { useEffect, useState } from 'react';
import { api, type Cli, type Item, type SessionState } from '../api.js';
import { ItemCard } from './ItemCard.js';
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
    <ItemCard title={title} item={item} variant="login" subtitle={cli === 'claude' ? 'Conecte sua conta do Claude para os agentes de IA trabalharem.' : 'Conecte sua conta do GitHub para usar seus repositórios.'} info={LOGIN_INFO[cli]} icon={cli === 'claude' ? 'claude' : 'github'} illustration={cli === 'claude' ? '/onboarding-claude.png' : '/onboarding-github-login.png'}>
      {/* Already logged in and no login running: nothing to start. */}
      {item?.ok && !url ? null : <LoginControls state={state} code={code} onCode={setCode} onStart={start} onSend={send} onCancel={() => api.cancel(cli)} />}
      {error ? <p className="error">{error}</p> : null}
      {url ? (
        <button type="button" className="link terminal-toggle" aria-expanded={showOutput} onClick={() => setShowOutput((v) => !v)}>
          <span className="terminal-toggle-label"><Icon name="terminal" size={22} />{showOutput ? 'Ocultar saída do CLI' : 'Mostrar saída do CLI'}</span>
          <Icon name="chevron" size={22} />
        </button>
      ) : null}
      {showOutput ? (
        <div className="terminal-output">
          <div className="terminal-output-header"><span>Saída do CLI</span><span>ao vivo</span></div>
          <pre className="output">{output}</pre>
        </div>
      ) : null}
    </ItemCard>
  );
}

export function LoginControls({ state, code, onCode, onStart, onSend, onCancel }: { state: SessionState; code: string; onCode: (v: string) => void; onStart: () => void; onSend: () => void; onCancel: () => void }) {
  const live = state.name === 'starting' || state.name === 'awaiting-browser' || state.name === 'awaiting-code' || state.name === 'verifying';
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copyCode = () => {
    if (!state.code) return;
    void navigator.clipboard?.writeText(state.code);
    setCopied(true);
  };
  return (
    <div className={`controls login-controls${state.name === 'awaiting-code' ? ' with-code' : ''}`}>
      {!live ? (
        <button type="button" className="primary-button" onClick={onStart}>
          {state.name === 'failed' ? 'Tentar novamente' : 'Entrar'}
        </button>
      ) : null}
      {state.name === 'starting' || state.name === 'verifying' ? <span className="spinner">{state.name === 'starting' ? 'Iniciando…' : 'Verificando…'}</span> : null}
      {state.name === 'awaiting-browser' || state.name === 'awaiting-code' ? (
        <div className="browser-step">
          {safeHttpUrl(state.url) ? (
            <a className="link-button" href={safeHttpUrl(state.url)} target="_blank" rel="noreferrer">
              <Icon name="external" size={22} />
              Abrir link
            </a>
          ) : null}
          {state.name === 'awaiting-browser' && state.code ? (
            <p>
              Digite este código na página:{' '}
              <button type="button" className="code-copy" aria-label="Copiar código" onClick={copyCode}>
                <code data-testid="one-time-code">{state.code}</code>
                <Icon name="copy" size={16} />
              </button>
              {copied ? <span className="code-copy-toast">Copiado!</span> : null}
            </p>
          ) : null}
        </div>
      ) : null}
      {state.name === 'awaiting-code' ? (
        <form
          className="code-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <label className="code-label">
            <span>Cole o código mostrado pela página</span>
            <input data-testid="code-input" value={code} onChange={(e) => onCode(e.target.value)} placeholder="Cole o código aqui…" autoComplete="off" />
          </label>
          <button type="submit" className="primary-button" disabled={code.trim() === ''}>
            <Icon name="send" size={20} />
            Enviar
          </button>
        </form>
      ) : null}
      {live ? (
        <button type="button" className="secondary" onClick={onCancel}>
          <Icon name="close" size={22} />
          Cancelar
        </button>
      ) : null}
      {state.name === 'failed' ? <p className="error login-status-error">{friendlyLoginReason(state.reason)}</p> : null}
    </div>
  );
}
