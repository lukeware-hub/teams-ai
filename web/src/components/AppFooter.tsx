export function AppFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-auto shrink-0 px-[clamp(1rem,3vw,2rem)] pt-10 pb-7">
      <div className="mx-auto flex max-w-[28rem] flex-col items-center gap-3 border-t border-line pt-7 text-center">
        <p className="m-0 text-[0.9375rem] font-semibold tracking-[-0.02em] text-ink">Lukeware</p>
        <p className="m-0 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[0.8125rem] text-ink-soft">
          <a className="rounded-sm text-ink-soft no-underline underline-offset-2 transition-colors hover:text-accent-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" href="mailto:lukewaresoftwarehouse@gmail.com">
            lukewaresoftwarehouse@gmail.com
          </a>
          <span className="text-ink-faint" aria-hidden="true">·</span>
          <a className="rounded-sm text-ink-soft no-underline underline-offset-2 transition-colors hover:text-accent-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" href="tel:+5519997143026">
            (19) 99714-3026
          </a>
        </p>
        <div className="grid max-w-[42ch] gap-1 text-[0.75rem] leading-[1.55] text-ink-faint">
          <p className="m-0">© {year} Lukeware Soft Warehouse. Todos os direitos autorais reservados.</p>
          <p className="m-0">Código sob licença privada — uso e distribuição não autorizados são proibidos.</p>
        </div>
      </div>
    </footer>
  );
}
