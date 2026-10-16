import { type ReactNode, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon, type IconName } from './Icons.js';
import { ThemeSwitch } from './ThemeSwitch.js';

// Each rail item and the paths that light it up.
const NAV: ReadonlyArray<{ to: string; label: string; icon: IconName; paths: string[] }> = [
  { to: '/projects', label: 'Projetos', icon: 'folder', paths: ['/projects', '/refine', '/runs'] },
  { to: '/chat', label: 'Chat de dúvidas', icon: 'chat', paths: ['/chat'] },
  { to: '/settings', label: 'Configurações', icon: 'settings', paths: ['/settings'] },
];

function Rail({ active }: { active: (typeof NAV)[number] | undefined }) {
  return (
    <nav
      aria-label="Navegação principal"
      className="edge-lit z-10 flex items-center after:hidden gap-2 border-line bg-surface shadow-card max-md:order-last max-md:justify-around max-md:overflow-x-clip max-md:border-t max-md:px-3 max-md:py-2 md:flex-col md:justify-self-center md:self-center md:rounded-[2rem] md:border md:px-2.5 md:py-4"
    >
      <Link
        to="/"
        aria-label="Teams AI, início"
        title="Teams AI"
        className="grid size-11 place-items-center rounded-tile text-on-accent no-underline shadow-accent [background:var(--gradient-primary)]"
      >
        <Icon name="grid" size={20} />
      </Link>
      <span className="h-px w-8 bg-line max-md:hidden" aria-hidden="true" />
      {NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-label={item.label}
          title={item.label}
          aria-current={item === active ? 'page' : undefined}
          className="relative grid size-11 place-items-center rounded-tile text-ink-soft no-underline transition-colors hover:bg-surface-muted hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-ink"
        >
          <Icon name={item.icon} size={20} />
          {item === active ? <span className="absolute top-1/2 -right-1.5 size-1.5 -translate-y-1/2 rounded-full bg-accent-text max-md:hidden" aria-hidden="true" /> : null}
        </Link>
      ))}
      <span className="md:mt-6">
        <ThemeSwitch />
      </span>
    </nav>
  );
}

// The app fills the window height; an empty column as wide as the rail mirrors it, so the content is always exactly centered and scrolls inside.
export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const active = NAV.find((item) => item.paths.some((p) => pathname.startsWith(p)));
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.title = active ? `${active.label} · Teams AI` : 'Teams AI';
  }, [active]);
  // Each route starts at the top of the content, and the content takes focus for keyboard and screen reader users.
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
    content.current?.focus({ preventScroll: true });
  }, [pathname]);
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-tile focus:bg-surface focus:px-4 focus:py-2 focus:text-ink focus:shadow-pop"
      >
        Pular para o conteúdo
      </a>
      <div className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] mx-auto max-w-[110rem] md:grid-cols-[4.5rem_minmax(0,1fr)_4.5rem] md:grid-rows-1 md:gap-4 md:p-4">
        <Rail active={active} />
        <div id="main" ref={content} tabIndex={-1} className="min-h-0 min-w-0 overflow-y-auto focus:outline-none">
          {children}
        </div>
      </div>
    </>
  );
}
