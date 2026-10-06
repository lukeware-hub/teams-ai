import { useState } from 'react';
import { api, type Item } from '../api.js';
import { ItemCard } from './ItemCard.js';

const GITHUB_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=teams-ai';

const COPY = {
  GITHUB_TOKEN: {
    subtitle: 'Cole um token de acesso pessoal para o Teams AI publicar código em seu nome.',
    info: 'Crie o token no GitHub, em Settings › Developer settings. Ele fica guardado só neste computador e nunca é repassado aos agentes.',
    field: 'Cole o token de acesso',
    replace: 'Substituir token salvo',
  },
  OPENROUTER_API_KEY: {
    subtitle: 'Opcional: habilita o Jev, que revisa a consistência dos documentos.',
    info: 'O Jev é um assistente de IA acessado pelo OpenRouter, que confere documentos e agiliza decisões simples. Sem a chave, o Teams AI funciona normalmente, só que sem ele.',
    field: 'Cole a chave de API',
    replace: 'Substituir chave salva',
  },
};

export function SecretCard({ name, title, item, onSaved }: { name: 'GITHUB_TOKEN' | 'OPENROUTER_API_KEY'; title: string; item: Item | null; onSaved: (item: Item) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.secret(name, value);
      setValue('');
      onSaved(r.item);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = COPY[name];
  return (
    <ItemCard title={title} item={item} variant="login" subtitle={copy.subtitle} info={copy.info} icon={name === 'GITHUB_TOKEN' ? 'github' : 'user'} illustration={name === 'GITHUB_TOKEN' ? '/onboarding-github-token.png' : '/onboarding-openrouter.png'}>
      <form
        className="secret-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="secret-field">
          <span>{item?.secret?.set ? copy.replace : copy.field}</span>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Cole o valor aqui…" autoComplete="off" />
        </label>
        <button type="submit" className="primary-button" disabled={busy || value.trim() === ''}>
          {busy ? 'Verificando…' : 'Salvar e verificar'}
        </button>
      </form>
      {name === 'GITHUB_TOKEN' ? (
        <p>
          <a href={GITHUB_TOKEN_URL} target="_blank" rel="noreferrer">Criar o token já com as permissões certas (repo e workflow)</a>
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
