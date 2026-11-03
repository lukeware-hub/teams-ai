export function AppFooter() {
  const year = new Date().getFullYear();
  return (
    <footer data-testid="app-footer" className="w-full shrink-0 border-t border-line bg-surface/80 px-[clamp(1rem,3vw,2rem)] py-5 backdrop-blur-sm max-md:order-2">
      <div data-testid="app-footer-content" className="mx-auto flex max-w-[72rem] flex-col gap-4">
        <div data-testid="app-footer-row" className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <img data-testid="app-footer-logo-light" className="app-footer-logo app-footer-logo--light h-7 w-auto" src="/lukeware-lockup-light.png" alt="Lukeware" height={28} />
          <img data-testid="app-footer-logo-dark" className="app-footer-logo app-footer-logo--dark h-7 w-auto" src="/lukeware-lockup-dark.png" alt="" height={28} aria-hidden="true" />
          <p data-testid="app-footer-contact" className="m-0 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[0.8125rem] text-ink-soft">
            <a data-testid="app-footer-email" className="rounded-sm text-ink-soft no-underline underline-offset-2 transition-colors hover:text-accent-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" href="mailto:lukewaresoftwarehouse@gmail.com">
              lukewaresoftwarehouse@gmail.com
            </a>
            <span data-testid="app-footer-separator" className="text-ink-faint" aria-hidden="true">·</span>
            <a data-testid="app-footer-phone" className="rounded-sm text-ink-soft no-underline underline-offset-2 transition-colors hover:text-accent-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" href="tel:+5519997143026">
              (19) 99714-3026
            </a>
          </p>
        </div>
        <p data-testid="app-footer-copyright" className="m-0 border-t border-line pt-3 text-center text-[0.75rem] leading-[1.55] text-ink-faint">
          © {year} Lukeware Soft Warehouse. Todos os direitos autorais reservados. Código sob licença privada — uso e distribuição não autorizados são proibidos.
        </p>
      </div>
    </footer>
  );
}
