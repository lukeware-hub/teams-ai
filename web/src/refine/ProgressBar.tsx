type Props = { label: string; done: number; total: number; testId: string };

/** A thin bar for done out of total; the width is the rounded percent. */
export function ProgressBar({ label, done, total, testId }: Props) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-accent-line" data-testid={testId}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" data-testid={`${testId}-bar`} style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }} />
    </div>
  );
}
