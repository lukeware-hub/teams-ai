import type { SpecsVerdictView } from '../api.js';
import { Icon } from '../components/Icons.js';

type Reviews = Partial<Record<'po' | 'sm', SpecsVerdictView>>;
type Role = 'po' | 'sm';

const ROLE_LABEL: Record<Role, string> = { po: 'Produto (PO)', sm: 'Técnico (SM)' };
const SHORT_ROLE: Record<Role, string> = { po: 'PO', sm: 'SM' };
const VERDICT_LABEL: Record<SpecsVerdictView['verdict'], string> = { approved: 'Aprovado', rejected: 'Reprovado', failed: 'Falhou' };

/** The verdict of this role on the specs.md with this hash; an older text's verdict counts for nothing. */
export const currentReview = (reviews: Reviews, role: Role, hash: string | undefined): SpecsVerdictView | undefined =>
  hash !== undefined && reviews[role]?.specsHash === hash ? reviews[role] : undefined;

/** Why the final review cannot go on yet, in plain words; null once specs.md is written and PO and SM approved it. */
export function specsBlockReason(status: string, hash: string | undefined, reviews: Reviews): string | null {
  if (status !== 'ready') return 'Aguardando o backlog ficar pronto';
  if (hash === undefined) return 'Gerando o specs.md';
  const missing = (['po', 'sm'] as const).filter((role) => currentReview(reviews, role, hash)?.verdict !== 'approved');
  return missing.length === 0 ? null : `Falta a aprovação do ${missing.map((role) => SHORT_ROLE[role]).join(' e do ')}`;
}

const stamp = (at: string): string => new Date(at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** The specs.md check in the verification panel: the file, what PO and SM said of it, and when. */
export function SpecsCheck({ specsMd, reviews, busy }: { specsMd: { hash: string } | null | undefined; reviews: Reviews; busy: boolean }) {
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
      <ul data-testid="specs-check-reviewers" className="m-0 mt-[0.6rem] grid list-none gap-[0.45rem] p-0">
        {current.map(({ role, review }) => {
          const label = review ? VERDICT_LABEL[review.verdict] : busy ? 'Analisando' : 'Pendente';
          return (
            <li data-testid={`specs-check-${role}`} key={role} className="grid gap-[0.2rem]">
              <div className="flex items-center justify-between gap-3">
                <span data-testid={`specs-check-${role}-label`} className="text-ink">{ROLE_LABEL[role]}</span>
                <span data-testid={`specs-check-${role}-status`} className={`status-dot ${review?.verdict === 'approved' ? 'ok' : review ? 'warn' : ''}`}>{label}</span>
              </div>
              {review?.verdict === 'rejected' && (
                <ul data-testid={`specs-check-${role}-findings`} className="m-0 grid list-none gap-[0.2rem] p-0 text-ink-soft">
                  {review.findings.map((finding, n) => <li key={n} data-testid={`specs-check-${role}-finding`}>{finding}</li>)}
                </ul>
              )}
              {review?.verdict === 'failed' && <p data-testid={`specs-check-${role}-reason`} className="m-0 text-ink-soft">{review.reason}</p>}
            </li>
          );
        })}
      </ul>
      <p data-testid="specs-check-last" className="m-0 mt-[0.6rem] text-ink-soft">{lastAt ? `Última validação: ${stamp(lastAt)}` : 'Nenhuma validação ainda.'}</p>
    </section>
  );
}
