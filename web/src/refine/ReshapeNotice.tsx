import type { ReshapeRow } from '../api.js';

/** The newest reshape still applied, as a notice at the top of the page: the agent did it alone, so the notice only tells. */
export function ReshapeNotice({ reshapes, docName }: { reshapes: ReshapeRow[]; docName: (file: string) => string }) {
  const reshape = [...reshapes].reverse().find((r) => r.status === 'applied');
  if (!reshape || reshape.closed) return null;
  return (
    <div role="status" data-testid="reshape-notice" className="flex flex-wrap items-center gap-3 rounded-lg border border-accent-line bg-accent-soft p-[0.85rem] text-[0.8125rem] leading-[1.45] text-ink">
      <span className="min-w-0 basis-full min-[640px]:flex-1 min-[640px]:basis-0" data-testid="reshape-notice-text">Reorganizei <b data-testid="reshape-notice-file">{docName(reshape.file)}</b> no modelo do documento.</span>
    </div>
  );
}
