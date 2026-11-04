import { Link } from 'react-router-dom';
import { Icon } from './Icons.js';
import { PROJECTS } from '../routes.js';

export type Crumb = { label: string; to?: string; testId: string };

/** The page's trail: Projetos first, every level above the page is a link, the last one names the page. */
export function Breadcrumb({ trail, testId }: { trail: Crumb[]; testId: string }) {
  return (
    <nav data-testid={testId} className="refine-breadcrumb" aria-label="Navegação">
      <Link to={PROJECTS} aria-label="Voltar para projetos"><Icon name="home" size={18} /><span data-testid={`${testId}-home-label`}>Projetos</span></Link>
      {trail.map((c, i) => (
        <span key={c.testId} className="contents">
          <span aria-hidden="true" data-testid={`${testId}-sep-${i + 1}`}>›</span>
          {c.to ? <Link to={c.to} data-testid={c.testId}>{c.label}</Link> : i === trail.length - 1 ? <strong aria-current="page" data-testid={c.testId}>{c.label}</strong> : <span data-testid={c.testId}>{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}
