import { useState } from 'react';
import { runApi, type GraphView } from '../../api.js';
import { action, panel, sectionHeading, sectionTitle } from '../project-shared.js';

const SIZE = 320;
const RADIUS = 140;
const TOP_LIST = 8;

/** The most connected modules on a ring, grouped by community; links are lines between them. */
function GraphMap({ view }: { view: GraphView }) {
  const ordered = [...view.top].sort((a, b) => a.community.localeCompare(b.community));
  const at = new Map(
    ordered.map((n, i) => {
      const angle = (2 * Math.PI * i) / ordered.length;
      return [n.id, { x: SIZE / 2 + RADIUS * Math.cos(angle), y: SIZE / 2 + RADIUS * Math.sin(angle) }] as const;
    }),
  );
  return (
    <svg data-testid="graph-map" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Mapa dos módulos mais ligados do grafo do código" className="mx-auto h-auto w-full max-w-[28rem] text-ink-faint">
      {view.topLinks.map((l) => (
        <line key={`${l.source}-${l.target}`} x1={at.get(l.source)!.x} y1={at.get(l.source)!.y} x2={at.get(l.target)!.x} y2={at.get(l.target)!.y} stroke="currentColor" strokeOpacity={0.35} />
      ))}
      {ordered.map((n) => (
        <circle key={n.id} cx={at.get(n.id)!.x} cy={at.get(n.id)!.y} r={3 + Math.min(5, n.edges / 20)} className="fill-current text-accent">
          <title>{`${n.label} (${n.edges} ligações)`}</title>
        </circle>
      ))}
    </svg>
  );
}

/** The project's code graph, closed by default: nothing is fetched until the owner opens it, and the map is drawn only on request. */
export function GraphPanel({ projectId, repo }: { projectId: string; repo: string }) {
  const [view, setView] = useState<GraphView | null | undefined>(undefined);
  const [map, setMap] = useState(false);

  const onToggle = (open: boolean) => {
    if (!open || view !== undefined) return;
    runApi.repositoryGraph(projectId, repo).then(setView, () => setView(null));
  };

  return (
    <details className={panel} data-testid="repo-graph" onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary data-testid="graph-summary" className={`${sectionTitle} cursor-pointer`}>
        <h2 data-testid="graph-heading" className={sectionHeading}>Grafo do código</h2>
      </summary>
      {view === undefined && <p data-testid="graph-loading" className="hint" role="status">Carregando o grafo…</p>}
      {view === null && <p data-testid="graph-error" className="hint">Não foi possível ler o grafo. Tente de novo mais tarde.</p>}
      {view && !view.available && <p data-testid="graph-empty" className="hint">O grafo deste projeto ainda não foi construído. Ele é gerado ao importar o projeto e a cada entrega.</p>}
      {view?.available && (
        <div className="grid gap-3 text-[0.875rem]">
          <p data-testid="graph-counts" className="m-0">{`${view.nodes} nós · ${view.links} ligações · ${view.communities} comunidades`}</p>
          <p data-testid="graph-usage" className="m-0">
            {`Uso pelos agentes: ${view.usage.graph} pelo grafo · ${view.usage.grep} por busca de texto · ${view.usage.none} sem contexto de código`}
          </p>
          <ul data-testid="graph-top" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {view.top.slice(0, TOP_LIST).map((n) => (
              <li key={n.id} className="count-pill" title={n.file}>{`${n.label} (${n.edges})`}</li>
            ))}
          </ul>
          <button data-testid="graph-map-toggle" type="button" className={action.secondary} aria-expanded={map} onClick={() => setMap((v) => !v)}>
            {map ? 'Esconder mapa' : 'Ver mapa'}
          </button>
          {map && <GraphMap view={view} />}
        </div>
      )}
    </details>
  );
}
