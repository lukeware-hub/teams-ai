import { useEffect, useState } from 'react';
import { api, type Cli, type Item, type SessionState } from '../api.js';
import { ItemCard } from './ItemCard.js';
import { useSse } from '../useSse.js';

export function LoginCard({ cli, title, item, onDone }: { cli: Cli; title: string; item: Item | null; onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const { state, output, setState } = useSse(url);
  const [code, setCode] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const start = async () => {
    const r = await api.login(cli);
    setCode('');
    if (r.state.name === 'done') {
      onDone();
      return;
    }
    setState(r.state);
    setUrl(api.events(cli));
  };
  const send = async () => {
    await api.code(cli, code);
    setCode('');
  };
  useEffect(() => {
    if (state.name !== 'done' || !url) return;
    setUrl(null);
    onDone();
  }, [state.name, url, onDone]);
  return (
    <ItemCard title={title} item={item}>
      <LoginControls state={state} code={code} onCode={setCode} onStart={start} onSend={send} onCancel={() => api.cancel(cli)} />
      {url ? (
        <button type="button" className="link" onClick={() => setShowOutput((v) => !v)}>
          {showOutput ? 'Ocultar saída do CLI' : 'Mostrar saída do CLI'}
        </button>
      ) : null}
      {showOutput ? <pre className="output">{output}</pre> : null}
    </ItemCard>
  );
}

export function LoginControls({ state, code, onCode, onStart, onSend, onCancel }: { state: SessionState; code: string; onCode: (v: string) => void; onStart: () => void; onSend: () => void; onCancel: () => void }) {
  const live = state.name === 'starting' || state.name === 'awaiting-browser' || state.name === 'awaiting-code' || state.name === 'verifying';
  return (
    <div className="controls">
      {!live ? (
        <button type="button" onClick={onStart}>
          {state.name === 'failed' ? 'Tentar novamente' : 'Entrar'}
        </button>
      ) : null}
      {state.name === 'starting' || state.name === 'verifying' ? <span className="spinner">{state.name === 'starting' ? 'Iniciando…' : 'Verificando…'}</span> : null}
      {state.name === 'awaiting-browser' || state.name === 'awaiting-code' ? (
        <>
          {state.url ? (
            <a href={state.url} target="_blank" rel="noreferrer">
              Abrir link
            </a>
          ) : null}
          {state.name === 'awaiting-browser' && state.code ? (
            <p>
              Digite este código na página: <code data-testid="one-time-code">{state.code}</code>
            </p>
          ) : null}
        </>
      ) : null}
      {state.name === 'awaiting-code' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <label>
            Cole o código mostrado pela página
            <input data-testid="code-input" value={code} onChange={(e) => onCode(e.target.value)} autoComplete="off" />
          </label>
          <button type="submit" disabled={code.trim() === ''}>
            Enviar
          </button>
        </form>
      ) : null}
      {live ? (
        <button type="button" className="secondary" onClick={onCancel}>
          Cancelar
        </button>
      ) : null}
      {state.name === 'failed' ? <p className="error">{state.reason}</p> : null}
    </div>
  );
}
