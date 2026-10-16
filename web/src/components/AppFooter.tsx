export function AppFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="w-full shrink-0 border-t border-line bg-surface/80 px-[clamp(1rem,3vw,2rem)] py-4 backdrop-blur-sm max-md:order-2">
      <div className="mx-auto flex max-w-[28rem] flex-col items-center gap-2 text-center">
        <img className="app-footer-logo app-footer-logo--light h-7 w-auto" src="/lukeware-lockup-light.png" alt="Lukeware" height={28} />
        <img className="app-footer-logo app-footer-logo--dark h-7 w-auto" src="/lukeware-lockup-dark.png" alt="" height={28} aria-hidden="true" />
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
