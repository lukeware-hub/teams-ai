import { useState } from 'react';
import type { SpecsVerdictView } from '../api.js';
import { Icon } from '../components/Icons.js';

type Reviews = Partial<Record<'po' | 'sm', SpecsVerdictView>>;
type Role = 'po' | 'sm';

const SHORT_ROLE: Record<Role, string> = { po: 'PO', sm: 'SM' };
const VERDICT_LABEL: Record<SpecsVerdictView['verdict'], string> = { approved: 'Aprovado', rejected: 'Reprovado', failed: 'Falhou' };

/** The verdict of this role on the specs.md with this hash; an older text's verdict counts for nothing. */
export const currentReview = (reviews: Reviews, role: Role, hash: string | undefined): SpecsVerdictView | undefined =>
  hash !== undefined && reviews[role]?.specsHash === hash ? reviews[role] : undefined;

/** What a reviewer said of the current specs.md, as the chip at the end of its checklist row reads it. */
export function reviewChip(review: SpecsVerdictView | undefined, busy: boolean): { label: string; tone: string } {
  if (!review) return { label: busy ? 'Analisando' : 'Pendente', tone: '' };
  return { label: VERDICT_LABEL[review.verdict], tone: review.verdict === 'approved' ? 'ok' : 'warn' };
}

/** Why the final review cannot go on yet, in plain words; null once specs.md is written and PO and SM approved it. */
export function specsBlockReason(status: string, hash: string | undefined, reviews: Reviews, running = true, asked = false): string | null {
  if (asked) return 'Responda as perguntas sobre o specs.md';
  if (status !== 'ready') return 'Aguardando o backlog ficar pronto';
  if (hash === undefined) {
    if (running) return 'Gerando o specs.md';
    return reviews.po?.verdict === 'failed' || reviews.sm?.verdict === 'failed' ? 'A geração do specs.md falhou. Use Tentar de novo.' : 'Preparando o specs.md';
  }
  const missing = (['po', 'sm'] as const).filter((role) => currentReview(reviews, role, hash)?.verdict !== 'approved');
  return missing.length === 0 ? null : `Falta a aprovação do ${missing.map((role) => SHORT_ROLE[role]).join(' e do ')}`;
}

const stamp = (at: string): string => new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** The specs.md check in the verification panel: the file, what PO and SM said of it, and when. */
/** The automatic repairs a rejected specs.md gets before the owner is asked; the same number the server uses. */
export const SPECS_REPAIRS = 4;

export function SpecsCheck({ specsMd, reviews, busy, onRetry, repairs = 0, asked = false, onAsk, onApprove, waitingOn = [] }: { specsMd: { hash: string } | null | undefined; reviews: Reviews; busy: boolean; onRetry?: () => void | Promise<unknown>; repairs?: number; asked?: boolean; onAsk?: () => void; onApprove?: () => void; waitingOn?: readonly string[] }) {
  // Why the last click started nothing, as the server said it.
  const [note, setNote] = useState('');
  const hash = specsMd?.hash;
  const bothFailed = reviews.po?.verdict === 'failed' && reviews.sm?.verdict === 'failed';
  const fileStatus = hash !== undefined ? 'Gerado' : busy ? 'Gerando' : bothFailed ? 'Falhou' : 'Aguardando o backlog';
  const current = (['po', 'sm'] as const).map((role) => ({ role, review: currentReview(reviews, role, hash) }));
  const lastAt = current.map((c) => c.review?.at).filter((at): at is string => Boolean(at)).sort().at(-1);
  return (
    <section data-testid="specs-check" className="my-2 rounded-lg border border-line bg-surface p-[0.85rem] text-[0.8rem]">
      <div data-testid="specs-check-heading" className="flex items-center justify-between gap-3">
        <strong data-testid="specs-check-title" className="flex items-center gap-2 text-ink"><Icon name="file" size={18} />specs.md</strong>
        <span data-testid="specs-check-file-status" className="text-[0.75rem] font-semibold text-ink-soft">{fileStatus}</span>
      </div>
      {current.some((c) => c.review?.verdict === 'rejected' || c.review?.verdict === 'failed') && (
        <ul data-testid="specs-check-reviewers" className="m-0 mt-[0.6rem] grid list-none gap-[0.45rem] p-0">
          {current.map(({ role, review }) => (
            <li data-testid={`specs-check-${role}`} key={role} className="grid gap-[0.2rem] empty:hidden">
              {review?.verdict === 'rejected' && (
                <ul data-testid={`specs-check-${role}-findings`} className="m-0 grid list-none gap-[0.2rem] p-0 text-ink-soft">
                  {review.findings.map((finding, n) => <li key={n} data-testid={`specs-check-${role}-finding`}>{SHORT_ROLE[role]}: {finding}</li>)}
                </ul>
              )}
              {review?.verdict === 'failed' && <p data-testid={`specs-check-${role}-reason`} className="m-0 text-ink-soft">{SHORT_ROLE[role]}: {review.reason}</p>}
            </li>
          ))}
        </ul>
      )}
      {busy && repairs > 0 && <p data-testid="specs-check-repairing" className="m-0 mt-[0.6rem] text-ink-soft">Os agentes estão corrigindo o que os revisores apontaram (tentativa {repairs} de {SPECS_REPAIRS}).</p>}
      {!busy && repairs >= SPECS_REPAIRS && current.some((c) => c.review?.verdict === 'rejected') && (
        <div data-testid="specs-check-gave-up" className="mt-[0.6rem] grid gap-2">
          <p className="m-0 text-warn">{asked ? `Os agentes tentaram corrigir ${SPECS_REPAIRS} vezes e precisam de uma decisão sua. Responda as perguntas abaixo, ou clique em Preparar backlog.` : `Os agentes tentaram corrigir ${SPECS_REPAIRS} vezes e não resolveram. Clique em Preparar backlog: o time responde as perguntas, corrige os documentos e as specs e prepara os planos, para liberar o início do desenvolvimento.`}</p>
          <div className="flex flex-wrap gap-2">
            {onAsk && <button type="button" data-testid="specs-check-ask" className="primary h-10 px-[0.8rem]" onClick={onAsk}>Pedir ajuda ao time</button>}
            {onApprove && <button type="button" data-testid="specs-check-approve" className="secondary h-10 px-[0.8rem]" onClick={onApprove}>Seguir mesmo assim</button>}
          </div>
        </div>
      )}
      {!busy && onRetry && !asked && !(repairs >= SPECS_REPAIRS && current.some((c) => c.review?.verdict === 'rejected')) && !current.every((c) => c.review?.verdict === 'approved') && (
        <div className="mt-[0.6rem] grid gap-1">
          <button type="button" data-testid="specs-check-retry" className="primary h-10 px-[0.8rem]" onClick={() => void Promise.resolve(onRetry()).then((r) => setNote((r as { started?: boolean; reason?: string } | undefined)?.started === false ? ((r as { reason?: string }).reason ?? '') : ''))}>{hash === undefined ? 'Gerar e checar o specs.md' : 'Checar de novo'}</button>
          {note && <span data-testid="specs-check-note" role="status" className="text-warn">{note}</span>}
          {waitingOn.length > 0 && <span data-testid="specs-check-waiting" className="text-ink-soft">Antes de checar, o time revisa os documentos, e eles ainda têm pendências: {waitingOn.join('; ')}.</span>}
          <span className="text-ink-soft">Só roda quando você clicar: abrir ou recarregar a página não chama os agentes.</span>
        </div>
      )}
      <p data-testid="specs-check-last" className="m-0 mt-[0.6rem] text-ink-soft">{lastAt ? `Última validação: ${stamp(lastAt)}` : 'Nenhuma validação ainda.'}</p>
    </section>
  );
}
