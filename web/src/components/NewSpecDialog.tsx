import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { refineApi } from '../api.js';
import { action } from '../pages/project-shared.js';
import { refinePath } from '../routes.js';
import { ActionButton } from './ActionButton.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Dialog } from './Dialog.js';
import { Icon } from './Icons.js';

/**
 * The large modal where the user describes a new spec. Confirming starts the request and opens its refinement screen,
 * where the agents organize the spec. A request can be made at any time: while the agents work on an earlier one it waits in the queue.
 */
export function NewSpecDialog({ projectId, queueBehind, returnFocus, onClose }: { projectId: string; queueBehind?: string; returnFocus?: HTMLElement | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // The dialog focuses its close button first; this effect runs after it and moves focus to the field.
  useEffect(() => field.current?.focus(), []);
  const tryClose = () => (description.trim() === '' ? onClose() : setDiscarding(true));
  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { sessionId } = await refineApi.request(projectId, description.trim());
      navigate(refinePath(...(sessionId.split('/') as [string, string])));
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  };
  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      setDescription((await refineApi.suggestRequest(projectId, description.trim())).text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };
  return (
    <>
      <Dialog title={`Nova spec · ${projectId}`} size="large" returnFocus={returnFocus} onClose={tryClose}>
          <form
            data-testid="new-spec-form"
            className="grid content-start gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label data-testid="new-spec-description-label" className="text-[0.8125rem] font-semibold" htmlFor="new-spec-description">Descreva o que adicionar ou mudar</label>
            <textarea className="min-h-[14rem] w-full min-w-0 resize-y p-3 text-[0.875rem] leading-normal" id="new-spec-description" data-testid="new-spec-description" rows={10} ref={field} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: o administrador precisa exportar o relatório mensal em PDF." />
            {queueBehind ? <p data-testid="new-spec-queue" role="status" className="m-0 rounded-lg border border-accent-line bg-accent-soft px-3.5 py-2.5 text-[0.8125rem] leading-normal text-ink">Os agentes ainda trabalham em <b className="font-semibold">{queueBehind}</b>. Você pode criar esta spec agora: ela entra na fila e o refinamento começa sozinho quando eles terminarem.</p> : null}
            <p data-testid="new-spec-helper" className="m-0 text-[0.8125rem] leading-normal text-ink-soft">Os agentes leem os documentos e as specs, organizam a descrição no padrão das outras specs e medem o impacto. Você só responde o que eles não decidirem sozinhos.</p>
            {error ? <div className="error" role="alert" data-testid="new-spec-error">{error}</div> : null}
            <div data-testid="new-spec-actions" className="new-spec-actions flex flex-wrap justify-end gap-2">
              <button type="button" className={action.secondary} data-testid="cancel-new-spec" onClick={tryClose}>Cancelar</button>
              <ActionButton type="button" className={action.secondary} data-testid="suggest-new-spec" busy={suggesting} disabled={description.trim() === '' || submitting} title="Detalha o texto com o que o código do projeto já tem" onClick={() => void suggest()} icon={<Icon name="lightbulb" size={14} />}>
                {suggesting ? 'Sugerindo…' : 'Sugestão'}
              </ActionButton>
              <ActionButton type="submit" className={action.primary} data-testid="new-spec" busy={submitting} disabled={description.trim() === '' || suggesting} icon={<Icon name="arrow-right" size={14} />}>Criar spec</ActionButton>
            </div>
          </form>
      </Dialog>
      {discarding ? (
        <ConfirmDialog title="Descartar a descrição?" confirmLabel="Descartar" confirmTestId="discard-new-spec" onCancel={() => setDiscarding(false)} onConfirm={onClose}>
          O texto digitado será perdido.
        </ConfirmDialog>
      ) : null}
    </>
  );
}
