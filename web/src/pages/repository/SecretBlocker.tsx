import { useState } from 'react';
import { runApi, type DashboardItem } from '../../api.js';
import { ActionButton } from '../../components/ActionButton.js';
import { Icon } from '../../components/Icons.js';

type Secret = NonNullable<DashboardItem['secret']>;

/** A secret the project is missing: what it is, what it is for and where it is used, with an optional field to save its value. */
export function SecretBlocker({ projectId, secret, testId, onSaved }: { projectId: string; secret: Secret; testId: string; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = `${testId}-secret-${secret.name}`;
  const facts = [
    ['O que é', secret.what],
    ['Para que serve', secret.purpose],
    ['Onde é usado', secret.usage],
    ['Citado em', secret.mentions.length > 0 ? secret.mentions.join('; ') : null],
  ].filter((fact): fact is [string, string] => fact[1] !== null);
  const save = async () => {
    setError(null);
    try {
      await runApi.saveSecret(projectId, secret.name, value);
      setValue('');
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <li data-testid={id} className="border-t border-line py-2 first:border-t-0">
      <details>
        <summary data-testid={`${id}-summary`} className="flex min-w-0 cursor-pointer items-center gap-[0.45rem]">
          <code className="mr-auto text-[0.78rem] font-bold text-ink wrap-anywhere">{secret.name}</code>
          <span className="status-dot warn">Não salvo</span>
        </summary>
        <div className="mt-2 grid gap-2">
          {facts.length > 0 && (
            <dl data-testid={`${id}-facts`} className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 max-[720px]:grid-cols-1">
              {facts.map(([label, text]) => (
                <div key={label} className="contents">
                  <dt className="text-ink-soft">{label}</dt>
                  <dd className="m-0 wrap-anywhere">{text}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2 max-[720px]:grid-cols-1">
            <input type="password" autoComplete="new-password" className="m-0 w-full min-w-0" data-testid={`${id}-input`} aria-label={`Valor de ${secret.name}`} placeholder="Cole o valor da chave" value={value} onChange={(e) => setValue(e.target.value)} />
            <ActionButton className="m-0 min-w-[5.4rem] max-[720px]:w-full" data-testid={`${id}-save`} disabled={value === ''} onClick={save} icon={<Icon name="check" size={14} />}>Salvar</ActionButton>
          </div>
          {error && <p data-testid={`${id}-error`} className="m-0 text-bad" role="alert">{error}</p>}
          <p className="hint m-0">Opcional. O valor fica neste computador e não é mostrado de novo.</p>
        </div>
      </details>
    </li>
  );
}
