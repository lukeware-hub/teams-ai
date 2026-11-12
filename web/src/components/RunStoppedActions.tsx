import { useState } from 'react';
import { action } from '../pages/project-shared.js';
import { ActionButton } from './ActionButton.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icons.js';

/**
 * What the owner can do with a run that stopped on its own (login expired or process gone): continue it, start over, or end it.
 * A run with a newer run of its spec cannot resume or restart, so it only offers Cancelar.
 */
export function RunStoppedActions({ runId, latest, onResume, onRestart, onCancel }: { runId: string; latest: boolean; onResume: (runId: string) => unknown; onRestart: (runId: string) => unknown; onCancel: (runId: string) => unknown }) {
  const [asking, setAsking] = useState<'restart' | 'cancel' | null>(null);
  const confirm = (go: (runId: string) => unknown) => async () => {
    await go(runId);
    setAsking(null);
  };
  return (
    <>
      {latest ? (
        <ActionButton className={action.secondary} data-testid={`resume-${runId}`} aria-label={`Retomar ${runId}`} onClick={() => onResume(runId)} icon={<Icon name="play" size={14} />}>
          Retomar
        </ActionButton>
      ) : null}
      {latest ? (
        <ActionButton className={action.secondary} data-testid={`restart-${runId}`} aria-label={`Recomeçar ${runId}`} onClick={() => setAsking('restart')} icon={<Icon name="refresh" size={14} />}>
          Recomeçar
        </ActionButton>
      ) : null}
      <ActionButton className={action.danger} data-testid={`cancel-${runId}`} aria-label={`Cancelar ${runId}`} onClick={() => setAsking('cancel')} icon={<Icon name="close" size={14} />}>
        Cancelar
      </ActionButton>
      {asking === 'restart' ? (
        <ConfirmDialog title="Recomeçar do zero?" subject={runId} confirmLabel="Recomeçar" tone="accent" icon="refresh" confirmTestId="restart-confirm" onCancel={() => setAsking(null)} onConfirm={confirm(onRestart)}>
          A execução atual é encerrada e uma nova começa. O que já foi enviado ao repositório fica.
        </ConfirmDialog>
      ) : null}
      {asking === 'cancel' ? (
        <ConfirmDialog title="Cancelar esta execução?" subject={runId} confirmLabel="Cancelar execução" icon="close" confirmTestId="cancel-confirm" onCancel={() => setAsking(null)} onConfirm={confirm(onCancel)}>
          A execução deixa de poder ser retomada. O que já foi enviado ao repositório fica.
        </ConfirmDialog>
      ) : null}
    </>
  );
}
