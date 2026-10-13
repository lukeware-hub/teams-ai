import { useState } from 'react';
import { api, type Item } from '../api.js';
import { ActionButton } from './ActionButton.js';
import { Icon } from './Icons.js';
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
    subtitle: 'Obrigatória: o Jev revisa a consistência dos documentos e decide pontos do refinamento.',
    info: 'O Jev é um assistente de IA acessado pelo OpenRouter. No refinamento ele confere se os documentos são consistentes e classifica e decide pontos da avaliação, como critérios ainda não prontos e perguntas repetidas. Sem a chave, o refinamento não inicia.',
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
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-end gap-[0.7rem] @max-[40rem]:grid-cols-[minmax(0,1fr)]"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="grid min-w-0 gap-[0.38rem] text-[0.8125rem] font-semibold text-ink-soft">
          <span>{item?.secret?.set ? copy.replace : copy.field}</span>
          <input className="w-full min-w-0" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Cole o valor aqui…" autoComplete="off" />
        </label>
        <ActionButton type="submit" className="primary-button @max-[40rem]:w-full" busy={busy} disabled={value.trim() === ''} icon={<Icon name="check" size={16} />}>
          {busy ? 'Verificando…' : 'Salvar e verificar'}
        </ActionButton>
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
