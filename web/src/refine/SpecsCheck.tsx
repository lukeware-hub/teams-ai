import { useState } from 'react';
import { ReviewDecision } from './ReviewDecision.js';
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

/** Why the start cannot go on yet for specs.md, in plain words; null once it is written from the current backlog. The reviewers' view never holds it. */
export function specsBlockReason(status: string, hash: string | undefined, running = true): string | null {
  if (status !== 'ready') return 'Aguardando o backlog ficar pronto';
  if (hash === undefined) return running ? 'Gerando o specs.md' : 'Gere o specs.md do backlog';
  return null;
}

const stamp = (at: string): string => new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** The specs.md check in the verification panel: the file, what PO and SM said of it once, and the owner's choice to apply their adjustments or go on without them. */
export function SpecsCheck({ specsMd, reviews, busy, followed = false, onRetry, onApply, onProceed, waitingOn = [] }: {
  specsMd: { hash: string } | null | undefined;
  reviews: Reviews;
  busy: boolean;
  followed?: boolean;
  onRetry?(): unknown;
  onApply?(): unknown;
  onProceed?(): unknown;
  waitingOn?: readonly string[];
}) {
  // Why the last click started nothing, as the server said it.
  const [note, setNote] = useState('');
  const hash = specsMd?.hash;
  const bothFailed = reviews.po?.verdict === 'failed' && reviews.sm?.verdict === 'failed';
  const fileStatus = hash !== undefined ? 'Gerado' : busy ? 'Gerando' : bothFailed ? 'Falhou' : 'Aguardando o backlog';
  const current = (['po', 'sm'] as const).map((role) => ({ role, review: currentReview(reviews, role, hash) }));
  const lastAt = current.map((c) => c.review?.at).filter((at): at is string => Boolean(at)).sort().at(-1);
  const findings = current.reduce((n, c) => n + (c.review?.verdict === 'rejected' ? c.review.findings.length : 0), 0);
  const unreviewed = hash === undefined || current.some((c) => !c.review || c.review.verdict === 'failed');
  return (
    <section data-testid="specs-check" className="my-2 grid gap-[0.6rem] rounded-lg border border-line bg-surface p-[0.85rem] text-[0.8rem]">
      <div data-testid="specs-check-heading" className="flex items-center justify-between gap-3">
        <strong data-testid="specs-check-title" className="flex items-center gap-2 text-ink"><Icon name="file" size={18} />specs.md</strong>
        <span data-testid="specs-check-file-status" className="text-[0.75rem] font-semibold text-ink-soft">{fileStatus}</span>
      </div>
      {current.some((c) => c.review?.verdict === 'rejected' || c.review?.verdict === 'failed') && (
        <ul data-testid="specs-check-reviewers" className="m-0 grid list-none gap-[0.45rem] p-0">
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
      {findings > 0 && !followed && onProceed && <ReviewDecision id="specs" suggestions={findings} questions={0} locked={busy} onApply={onApply} onProceed={onProceed} />}
      {findings > 0 && followed && <p data-testid="specs-check-followed" className="m-0 text-ink-soft">Você seguiu sem os ajustes do PO e do SM. Eles ficam registrados acima.</p>}
      {!busy && onRetry && unreviewed && (
        <div className="grid gap-1">
          <button type="button" data-testid="specs-check-retry" className="primary h-10 px-[0.8rem]" onClick={() => void Promise.resolve(onRetry()).then((r) => setNote((r as { started?: boolean; reason?: string } | undefined)?.started === false ? (r as { reason?: string }).reason ?? '' : ''))}>Gerar e revisar o specs.md</button>
          {note && <span data-testid="specs-check-note" role="status" className="text-warn">{note}</span>}
          {waitingOn.length > 0 && <span data-testid="specs-check-waiting" className="text-ink-soft">Antes de gerar, o time revisa os documentos, e eles ainda têm pendências: {waitingOn.join('; ')}.</span>}
          <span className="text-ink-soft">Só roda quando você clicar: abrir ou recarregar a página não chama os agentes.</span>
        </div>
      )}
      <p data-testid="specs-check-last" className="m-0 text-ink-soft">{lastAt ? `Última revisão: ${stamp(lastAt)}` : 'Nenhuma revisão ainda.'}</p>
    </section>
  );
}
