import { useEffect, useState } from 'react';
import { runApi, type GraphView } from '../../api.js';
import type { GraphViewNode } from '@server/api/repository-graph.js';
import { Icon } from '../../components/Icons.js';
import { action, panel, sectionHeading, sectionTitle } from '../project-shared.js';

const SIZE = 320;
const RADIUS = 140;
const TOP_LIST = 8;

/** What a node says on hover and to a screen reader: its name, its file and line, and whether the file opens. */
const nodeTitle = (n: GraphViewNode) => `${n.label} · ${n.file}${n.line ? `:${n.line}` : ''} (${n.edges} ligações)${n.url ? '' : ' · sem arquivo no GitHub'}`;

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
    <svg data-testid="graph-map" viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label="Mapa dos módulos mais ligados do grafo do código" className="mx-auto h-auto w-full max-w-[28rem] text-ink-faint">
      {view.topLinks.map((l) => (
        <line key={`${l.source}-${l.target}`} x1={at.get(l.source)!.x} y1={at.get(l.source)!.y} x2={at.get(l.target)!.x} y2={at.get(l.target)!.y} stroke="currentColor" strokeOpacity={0.35} />
      ))}
      {ordered.map((n) => {
        const { x, y } = at.get(n.id)!;
        const dot = <circle cx={x} cy={y} r={3 + Math.min(5, n.edges / 20)} className="fill-current stroke-transparent text-accent group-hover/dot:stroke-ink group-focus-visible/dot:stroke-ink" strokeWidth={2} />;
        // A node with a file is a link; the wide transparent circle is its click area, since the dot itself is a few pixels.
        return n.url ? (
          <a key={n.id} data-testid="graph-node-link" href={n.url} target="_blank" rel="noreferrer" className="group/dot cursor-pointer outline-none">
            <title>{nodeTitle(n)}</title>
            <circle cx={x} cy={y} r={10} fill="transparent" />
            {dot}
          </a>
        ) : (
          <g key={n.id} data-testid="graph-node">
            <title>{nodeTitle(n)}</title>
            {dot}
          </g>
        );
      })}
    </svg>
  );
}

/** What the graph says about the project and how the agents used it; it loads when it appears, and the owner can build it. */
export function GraphBody({ projectId }: { projectId: string }) {
  const [view, setView] = useState<GraphView | null | undefined>(undefined);
  const [map, setMap] = useState(false);
  const [building, setBuilding] = useState(false);
  // Why the last build failed, in the server's words.
  const [buildError, setBuildError] = useState<string | null>(null);

  useEffect(() => {
    runApi.projectGraph(projectId).then(setView, () => setView(null));
  }, [projectId]);

  const build = () => {
    setBuilding(true);
    setBuildError(null);
    runApi
      .rebuildProjectGraph(projectId)
      .then(() => runApi.projectGraph(projectId))
      .then(setView, (err: unknown) => setBuildError(err instanceof Error ? err.message : 'não foi possível construir o grafo'))
      .finally(() => setBuilding(false));
  };

  const buildButton = (label: string) => (
    <button data-testid="graph-build" type="button" className={action.secondary} disabled={building} onClick={build}>
      {building ? 'Construindo o grafo…' : label}
    </button>
  );

  return (
    <>
      {view === undefined && <p data-testid="graph-loading" className="hint" role="status">Carregando o grafo…</p>}
      {view === null && <p data-testid="graph-error" className="hint">Não foi possível ler o grafo. Tente de novo mais tarde.</p>}
      {view && !view.available && (
        <div className="grid justify-items-start gap-3">
          <p data-testid="graph-empty" className="hint m-0">O grafo deste projeto ainda não foi construído. Ele é gerado ao importar o projeto por link e a cada entrega.</p>
          {buildButton('Construir grafo')}
        </div>
      )}
      {buildError && <p data-testid="graph-build-error" className="error m-0" role="alert">{buildError}</p>}
      {view?.available && (
        <div className="grid gap-3 text-[0.875rem]">
          <p data-testid="graph-counts" className="m-0">{`${view.nodes} nós · ${view.links} ligações · ${view.communities} comunidades`}</p>
          <p data-testid="graph-usage" className="m-0">
            {`Uso pelos agentes: ${view.usage.graph} pelo grafo · ${view.usage.grep} por busca de texto · ${view.usage.none} sem contexto de código`}
          </p>
          <ul data-testid="graph-top" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {view.top.slice(0, TOP_LIST).map((n) => (
              <li key={n.id}>
                {n.url ? (
                  <a className="count-pill" data-testid="graph-top-link" href={n.url} target="_blank" rel="noreferrer" title={nodeTitle(n)}>{`${n.label} (${n.edges})`}</a>
                ) : (
                  <span className="count-pill" title={nodeTitle(n)}>{`${n.label} (${n.edges})`}</span>
                )}
              </li>
            ))}
          </ul>
          <button data-testid="graph-map-toggle" type="button" className={action.secondary} aria-expanded={map} onClick={() => setMap((v) => !v)}>
            {map ? 'Esconder mapa' : 'Ver mapa'}
          </button>
          {map && <GraphMap view={view} />}
          {buildButton('Atualizar grafo')}
        </div>
      )}
    </>
  );
}

/** The project's code graph as a panel, closed by default: nothing is fetched until the owner opens it. */
export function GraphPanel({ projectId }: { projectId: string }) {
  // The body is mounted on the first opening and kept, so a closed panel adds nothing to the page.
  const [opened, setOpened] = useState(false);
  return (
    <details className={`${panel} group`} data-testid="repo-graph" onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary data-testid="graph-summary" className={`${sectionTitle} cursor-pointer gap-2`}>
        <span data-testid="graph-chevron" className="grid flex-none place-items-center text-ink-soft transition-transform group-open:rotate-90"><Icon name="chevron-right" size={16} /></span>
        <h2 data-testid="graph-heading" className={sectionHeading}>Grafo do código</h2>
        <span data-testid="graph-hint" className="hint">Ver, construir e atualizar o grafo</span>
      </summary>
      {opened && <GraphBody projectId={projectId} />}
    </details>
  );
}
