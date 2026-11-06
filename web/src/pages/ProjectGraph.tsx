import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { runApi, type GraphView } from '../api.js';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { Loading } from '../components/Loading.js';
import { projectPath } from '../routes.js';
import { GraphCanvas } from './graph/GraphCanvas.js';
import { action, panel, plural, sectionHeading, when } from './project-shared.js';

/** Communities listed one by one; the rest share a single "Outras" line. */
const LISTED = 20;
const SEARCH_ROWS = 8;
const OTHERS = 'others';
const GREY = '#8a93a6';
/** The community the server gives to nodes that link to nothing. */
const UNLINKED = 'Sem ligações';

// Hues spread by the golden angle stay apart however many communities there are.
const colorFor = (rank: number) => `hsl(${Math.round((rank * 137.508) % 360)} 68% 58%)`;

/** The project's code graph on a screen of its own: the map by community, a list to turn communities on and off, a search, and the node picked. */
export function ProjectGraph() {
  const { projectId = '' } = useParams();
  const [view, setView] = useState<GraphView | null | undefined>(undefined);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [fileUrl, setFileUrl] = useState<string | null | undefined>(undefined);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  // The nodes with no link start turned off: they are most of the picture and tell little, and one tick brings them back.
  const first = useRef(true);
  const load = useCallback(
    () =>
      runApi.projectGraph(projectId).then(
        (next) => {
          if (first.current) setHidden(new Set((next.map?.communities ?? []).filter((c) => c.name === UNLINKED).map((c) => c.id)));
          first.current = false;
          setView(next);
        },
        () => setView(null),
      ),
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const map = view?.map;
  const communities = map?.communities ?? [];
  const listed = communities.slice(0, LISTED);
  const others = communities.slice(LISTED);
  const color = useMemo(() => {
    const byId = new Map(communities.map((c, i) => [c.id, i < LISTED ? colorFor(i) : GREY]));
    return (id: string) => byId.get(id) ?? GREY;
  }, [communities]);
  const nodeById = useMemo(() => new Map((map?.nodes ?? []).map((n) => [n.id, n])), [map]);
  const neighbours = useMemo(() => {
    const found = new Map<string, string[]>();
    for (const l of map?.links ?? []) {
      found.set(l.source, [...(found.get(l.source) ?? []), l.target]);
      found.set(l.target, [...(found.get(l.target) ?? []), l.source]);
    }
    return found;
  }, [map]);
  const matched = useMemo(() => {
    const text = query.trim().toLowerCase();
    return text === '' ? [] : (map?.nodes ?? []).filter((n) => n.label.toLowerCase().includes(text));
  }, [map, query]);
  const matchedIds = useMemo(() => new Set(matched.slice(0, 50).map((n) => n.id)), [matched]);
  const picked = selected === null ? null : nodeById.get(selected) ?? null;

  // The GitHub page of the file of the node picked, asked when it is picked.
  useEffect(() => {
    setFileUrl(undefined);
    if (!picked || picked.file === '') return;
    let live = true;
    runApi.projectGraphFile(projectId, picked.repo, picked.file, picked.line).then((u) => live && setFileUrl(u), () => live && setFileUrl(null));
    return () => {
      live = false;
    };
  }, [projectId, picked]);

  const toggle = (ids: readonly string[]) => {
    const next = new Set(hidden);
    const allHidden = ids.every((id) => next.has(id));
    for (const id of ids) (allHidden ? next.delete(id) : next.add(id));
    setHidden(next);
  };
  const toggleAll = () => setHidden(hidden.size === 0 ? new Set(communities.map((c) => c.id)) : new Set());

  const build = () => {
    setBuilding(true);
    setBuildError(null);
    runApi
      .rebuildProjectGraph(projectId)
      .then(() => load())
      .catch((err: unknown) => setBuildError(err instanceof Error ? err.message : 'não foi possível construir o grafo'))
      .finally(() => setBuilding(false));
  };
  const buildButton = (label: string) => (
    <button data-testid="graph-build" type="button" className={action.secondary} disabled={building} onClick={build}>
      {building ? 'Construindo o grafo…' : label}
    </button>
  );

  return (
    <main data-testid="project-graph-main" className="grid min-w-0 gap-4">
      <Breadcrumb testId="project-graph-breadcrumb" trail={[{ label: projectId, to: projectPath(projectId), testId: 'project-graph-breadcrumb-project' }, { label: 'Grafo do código', testId: 'project-graph-breadcrumb-current' }]} />
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 data-testid="project-graph-title" className="m-0 text-[1.375rem] leading-[1.3] text-ink">Grafo do código</h1>
          {view?.available ? (
            <>
              <p data-testid="graph-counts" className="mt-1.5 mb-0 text-[0.9375rem] text-ink-soft">{`${view.nodes} nós · ${view.links} ligações · ${plural(view.communities, 'comunidade', 'comunidades')}`}</p>
              {view.status?.updatedAt ? <p data-testid="graph-updated" className="mt-0.5 mb-0 text-[0.8125rem] text-ink-soft">{`Atualizado em ${when(view.status.updatedAt)}`}</p> : null}
            </>
          ) : null}
        </div>
        {view?.available ? <div className="max-sm:w-full">{buildButton('Atualizar grafo')}</div> : null}
      </header>
      {view === undefined ? <Loading /> : null}
      {view === null ? <p data-testid="graph-error" className="error m-0" role="alert">Não foi possível ler o grafo. Tente de novo mais tarde.</p> : null}
      {view?.status?.failure ? (
        <p data-testid="graph-failure" className="error m-0" role="alert">
          {`A última atualização do grafo falhou em ${when(view.status.failure.at)}: ${view.status.failure.message}. ${view.available ? 'O grafo abaixo é o da versão anterior. ' : ''}Use o botão para tentar de novo.`}
        </p>
      ) : null}
      {buildError ? <p data-testid="graph-build-error" className="error m-0" role="alert">{buildError}</p> : null}
      {view && !view.available ? (
        <section className={`${panel} justify-items-start gap-3`}>
          <p data-testid="graph-empty" className="m-0 text-ink-soft">O grafo deste projeto ainda não foi construído. Ele é gerado ao importar o projeto por link e a cada entrega.</p>
          {buildButton('Construir grafo')}
        </section>
      ) : null}
      {view?.available && map ? (
        <>
          <p data-testid="graph-usage" className="m-0 text-[0.875rem] text-ink-soft">
            {`Uso pelos agentes: ${view.usage.graph} pelo grafo · ${view.usage.grep} por busca de texto · ${view.usage.none} sem contexto de código`}
          </p>
          {map.truncated ? <p data-testid="graph-truncated" className="m-0 text-[0.8125rem] text-ink-soft">{`O mapa mostra os ${map.nodes.length} nós mais ligados de ${view.nodes}.`}</p> : null}
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="grid min-w-0 gap-3">
              <GraphCanvas nodes={map.nodes} links={map.links} colorOf={color} hidden={hidden} selected={selected} matches={matchedIds} onSelect={setSelected} />
              {picked ? (
                <section data-testid="graph-node-detail" className={`${panel} gap-2`}>
                  <h2 className={sectionHeading}>{picked.label}</h2>
                  <p className="m-0 text-[0.875rem] text-ink-soft">
                    {`${picked.file === '' ? 'sem arquivo' : `${picked.file}${picked.line ? `:${picked.line}` : ''}`} · ${plural(picked.edges, 'ligação', 'ligações')} · comunidade ${communities.find((c) => c.id === picked.community)?.name ?? ''}`}
                  </p>
                  {fileUrl ? <a data-testid="graph-node-link" className="link-button" href={fileUrl} target="_blank" rel="noreferrer">Abrir no GitHub</a> : null}
                  {(neighbours.get(picked.id) ?? []).length > 0 ? (
                    <ul data-testid="graph-neighbours" className="m-0 flex list-none flex-wrap gap-2 p-0">
                      {(neighbours.get(picked.id) ?? []).slice(0, 12).map((id) => (
                        <li key={id}>
                          <button type="button" className="count-pill min-w-[auto] cursor-pointer" onClick={() => setSelected(id)}>{nodeById.get(id)?.label ?? id}</button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ) : null}
            </div>
            <aside data-testid="graph-communities" className={`${panel} content-start gap-3 lg:max-h-[calc(60vh+8rem)] lg:overflow-auto`}>
              <label className="grid gap-1">
                <span className="sr-only">Buscar nó</span>
                <input data-testid="graph-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar nó pelo nome" className="w-full min-w-0" />
              </label>
              {matched.length > 0 ? (
                <ul data-testid="graph-matches" className="m-0 grid list-none gap-1 p-0">
                  {matched.slice(0, SEARCH_ROWS).map((n) => (
                    <li key={n.id}>
                      <button type="button" className="min-h-0 w-full min-w-0 justify-start border-transparent bg-transparent px-2 py-1 text-left text-[0.8125rem] font-medium" onClick={() => setSelected(n.id)}>{n.label}</button>
                    </li>
                  ))}
                  {matched.length > SEARCH_ROWS ? <li className="px-2 text-[0.75rem] text-ink-soft">{`e mais ${matched.length - SEARCH_ROWS}`}</li> : null}
                </ul>
              ) : query.trim() !== '' ? <p className="m-0 text-[0.8125rem] text-ink-soft">Nenhum nó com esse nome.</p> : null}
              <label className="flex items-center gap-2 text-[0.875rem] font-semibold text-ink">
                <input data-testid="graph-select-all" type="checkbox" className="m-0 size-4 min-w-0 flex-none p-0" ref={(el) => { if (el) el.indeterminate = hidden.size > 0 && hidden.size < communities.length; }} checked={hidden.size === 0} onChange={toggleAll} />
                Selecionar todas
              </label>
              <ul className="m-0 grid list-none gap-1 p-0">
                {listed.map((c, i) => (
                  <li key={c.id}>
                    <label className="flex items-center gap-2 text-[0.8125rem] text-ink">
                      <input data-testid={`graph-community-${c.id}`} type="checkbox" className="m-0 size-4 min-w-0 flex-none p-0" checked={!hidden.has(c.id)} onChange={() => toggle([c.id])} />
                      <span aria-hidden="true" className="size-2.5 flex-none rounded-full" style={{ background: colorFor(i) }} />
                      <span className="min-w-0 flex-1 wrap-anywhere">{c.name}</span>
                      <span className="tabular-nums text-ink-soft">{c.size}</span>
                    </label>
                  </li>
                ))}
                {others.length > 0 ? (
                  <li>
                    <label className="flex items-center gap-2 text-[0.8125rem] text-ink">
                      <input data-testid={`graph-community-${OTHERS}`} type="checkbox" className="m-0 size-4 min-w-0 flex-none p-0" ref={(el) => { if (el) el.indeterminate = others.some((c) => hidden.has(c.id)) && !others.every((c) => hidden.has(c.id)); }} checked={others.some((c) => !hidden.has(c.id))} onChange={() => toggle(others.map((c) => c.id))} />
                      <span aria-hidden="true" className="size-2.5 flex-none rounded-full" style={{ background: GREY }} />
                      <span className="min-w-0 flex-1">{`Outras (${others.length})`}</span>
                      <span className="tabular-nums text-ink-soft">{others.reduce((sum, c) => sum + c.size, 0)}</span>
                    </label>
                  </li>
                ) : null}
              </ul>
            </aside>
          </div>
        </>
      ) : null}
    </main>
  );
}
