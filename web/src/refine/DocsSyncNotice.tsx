import type { DocsSyncView } from '../api.js';

const GENERIC_FAILURE = 'Os documentos não foram publicados. Eles seguem salvos neste computador e a publicação tenta de novo.';

/** The store's refusal already names its documents in Portuguese; any other failure reads as the generic line. */
const plainFailure = (lastError: string): string => (lastError.startsWith('Não publicado') ? lastError : GENERIC_FAILURE);

const pendingLine = (pending: number): string =>
  `${pending} ${pending === 1 ? 'alteração espera' : 'alterações esperam'} publicação no repositório de documentos.`;

/** The documentation repository sync: a failure first, then the changes waiting; nothing once everything is published. */
export function DocsSyncNotice({ docsSync }: { docsSync?: DocsSyncView }) {
  if (!docsSync) return null;
  const { pending, lastError } = docsSync;
  if (lastError === null && pending === 0) return null;
  const failed = lastError !== null;
  const text = lastError !== null ? plainFailure(lastError) : pendingLine(pending);
  return (
    <div role="status" data-testid="docs-sync-notice" data-state={failed ? 'error' : 'pending'} className={`rounded-lg border p-[0.85rem] text-[0.8125rem] leading-[1.45] text-ink ${failed ? 'border-bad-line bg-bad-soft' : 'border-accent-line bg-accent-soft'}`}>
      {text}
    </div>
  );
}
