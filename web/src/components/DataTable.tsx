import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PAGE_SIZES, queryPage, type Page, type PageRequest, type TableSpec } from '@server/api/paging.js';
import { Icon } from './Icons.js';
import { Select } from './Select.js';

type Sort = { key: string; direction: 'asc' | 'desc' } | null;

// Numeric collation puts "T2" before "T10"; the facet options follow it.
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** The state every table shares: page, size, search text, facet and sort, with the search waiting for a pause in typing. */
function useTableControls(scope: string) {
  const [size, setSize] = useState<number>(PAGE_SIZES[1]);
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [query, setQueryNow] = useState('');
  const [facet, setFacetNow] = useState('');
  const [sort, setSortNow] = useState<Sort>(null);
  const [lastScope, setLastScope] = useState(scope);
  if (lastScope !== scope) {
    setLastScope(scope);
    setPage(1);
  }

  // The search goes back to the first page only when the text changed.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text.trim() === query) return;
      setQueryNow(text.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [text, query]);

  return {
    size,
    page,
    text,
    query,
    facet,
    sort,
    setPage,
    setText,
    setFacet: (value: string) => {
      setFacetNow(value);
      setPage(1);
    },
    setSize: (next: number) => {
      setSize(next);
      setPage(1);
    },
    toggleSort: (key: string) => {
      setSortNow(sort?.key !== key ? { key, direction: 'asc' } : sort.direction === 'asc' ? { key, direction: 'desc' } : null);
      setPage(1);
    },
    clear: () => {
      setText('');
      setQueryNow('');
      setFacetNow('');
      setPage(1);
    },
  };
}

type Controls = ReturnType<typeof useTableControls>;

/** The view a table's header, filters and pager read, from its controls and the current page of rows. */
function useTableView<T>(c: Controls, data: Page<T> | null, facetLabel: (value: string) => string, failed: boolean) {
  const matched = data?.matched ?? 0;
  const current = data?.page ?? c.page;
  // Sorting the facet labels is the costly part, so it reruns only when the facets or the label function change.
  const options = useMemo(() => (data?.facets ?? []).map((v) => ({ value: v, label: facetLabel(v) })).sort((a, b) => collator.compare(a.label, b.label)), [data?.facets, facetLabel]);
  return {
    rows: data?.list ?? [],
    loaded: data !== null,
    failed,
    total: data?.total ?? 0,
    matched,
    page: current,
    pages: data?.pages ?? 1,
    size: c.size,
    from: matched === 0 ? 0 : (current - 1) * c.size + 1,
    to: Math.min(current * c.size, matched),
    sort: c.sort,
    query: c.text,
    facet: c.facet,
    options,
    filtered: c.query !== '' || c.facet !== '',
    setQuery: c.setText,
    setFacet: c.setFacet,
    setPage: c.setPage,
    setSize: c.setSize,
    toggleSort: c.toggleSort,
    clear: c.clear,
  };
}

/** A table whose pages, search, facet and sort are read from the server one page at a time; the view feeds the header, filters and pager, and a new `reloadKey` reads the page again. */
export function usePagedTable<T>(scope: string, fetchPage: (req: PageRequest) => Promise<Page<T>>, facetLabel: (value: string) => string = (v) => v, reloadKey = '') {
  const c = useTableControls(scope);
  const [data, setData] = useState<Page<T> | null>(null);
  const [failed, setFailed] = useState(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const sortKey = c.sort?.key ?? null;
  const direction = c.sort?.direction ?? 'asc';
  const { setPage } = c;

  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchRef.current({ page: c.page, size: c.size, q: c.query.toLowerCase(), facet: c.facet, sort: sortKey, dir: direction })
      .then((next) => {
        if (!live) return;
        setData(next);
        setPage(next.page);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [scope, c.page, c.size, c.query, c.facet, sortKey, direction, reloadKey, setPage]);

  return useTableView(c, data, facetLabel, failed);
}

/** A table whose rows are already in the browser: the same pages, search, facet and sort as the server tables, cut with the same rules and shown at once. */
export function useLocalTable<T>(rows: T[], spec: TableSpec<T>, facetLabel: (value: string) => string = (v) => v) {
  const c = useTableControls('');
  const sortKey = c.sort?.key ?? null;
  const direction = c.sort?.direction ?? 'asc';
  const data = useMemo(() => queryPage(rows, spec, { page: c.page, size: c.size, q: c.query.toLowerCase(), facet: c.facet, sort: sortKey, dir: direction }), [rows, spec, c.page, c.size, c.query, c.facet, sortKey, direction]);
  return useTableView(c, data, facetLabel, false);
}

export type TableView<T = unknown> = ReturnType<typeof usePagedTable<T>>;

/** A column header that sorts on click; `tip` stays outside the button so the two controls never nest. */
export function SortHeader({ view, column, className, tip, children }: { view: Pick<TableView, 'sort' | 'toggleSort'>; column: string; className?: string; tip?: ReactNode; children: ReactNode }) {
  const active = view.sort?.key === column ? view.sort.direction : null;
  return (
    <th data-testid={`sort-header-${column}`} scope="col" className={`whitespace-nowrap ${className ?? ''}`} aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined}>
      <button data-testid={`sort-header-button-${column}`}
        type="button"
        className="min-w-[auto] inline-flex h-auto min-h-0 items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-[inherit] tracking-[inherit] uppercase hover:not-disabled:bg-transparent hover:not-disabled:text-ink"
        onClick={() => view.toggleSort(column)}
      >
        {children}
        <span data-testid={`sort-header-icon-${column}`} className={active ? 'text-accent-text' : 'text-ink-faint'}>
          <Icon name={active === 'asc' ? 'sort-up' : active === 'desc' ? 'sort-down' : 'sort'} size={14} />
        </span>
      </button>
      {tip}
    </th>
  );
}

/** Search box, dropdown filter, match count and a clear button, above a table. */
export function TableFilters({ view, subject, placeholder, facetName }: { view: TableView; subject: string; placeholder: string; facetName: string }) {
  return (
    <div data-testid="table-filters" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label data-testid="table-filters-search" className="relative block min-w-0 flex-[0_1_20rem] max-md:basis-full [&_svg]:pointer-events-none [&_svg]:absolute [&_svg]:top-1/2 [&_svg]:left-3 [&_svg]:-translate-y-1/2 [&_svg]:text-ink-faint">
        <span data-testid="table-filters-search-label" className="sr-only">Filtrar {subject}</span>
        <Icon name="search" size={16} />
        <input data-testid="table-filters-search-input" className="w-full min-w-0 appearance-none pl-[2.375rem]" type="search" value={view.query} onChange={(e) => view.setQuery(e.target.value)} placeholder={placeholder} />
      </label>
      {view.options.length > 1 ? (
        <label data-testid="table-filters-facet" className="block min-w-0 flex-none max-md:basis-full">
          <span data-testid="table-filters-facet-label" className="sr-only">{facetName}</span>
          <Select wrapperClassName="md:w-48" value={view.facet} onChange={(e) => view.setFacet(e.target.value)}>
            <option data-testid="table-filters-facet-all" value="">{facetName}: todos</option>
            {view.options.map((o) => <option data-testid={`table-filters-facet-option-${o.value}`} key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </label>
      ) : null}
      {view.filtered ? (
        <button data-testid="table-filters-clear"
          type="button"
          aria-label="Limpar filtros"
          className="min-w-[auto] w-[var(--control-height)] flex-none px-0"
          onClick={view.clear}
        >
          <Icon name="close" size={16} />
        </button>
      ) : null}
      <p data-testid="table-filters-count" className="m-0 text-[0.8125rem] text-ink-soft tabular-nums" aria-live="polite">{view.filtered ? `${view.matched} de ${view.total}` : ''}</p>
    </div>
  );
}

/** Page size choice, range and previous and next buttons under a table; hidden when every match fits the smallest page. */
export function Pagination({ view }: { view: Pick<TableView, 'matched' | 'page' | 'pages' | 'size' | 'from' | 'to' | 'setPage' | 'setSize'> }) {
  if (view.matched <= PAGE_SIZES[0]) return null;
  return (
    <nav data-testid="pagination" className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 max-sm:grid max-sm:grid-cols-2" aria-label="Paginação">
      <label data-testid="pagination-size" className="flex items-center gap-2 text-[0.8125rem] text-ink-soft max-sm:col-span-2 max-sm:justify-between">
        <span data-testid="pagination-size-label">Itens por página</span>
        <Select wrapperClassName="w-20" value={view.size} onChange={(e) => view.setSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option data-testid={`pagination-size-option-${n}`} key={n} value={n}>{n}</option>)}
        </Select>
      </label>
      <div data-testid="pagination-controls" className="flex items-center gap-3 max-sm:contents">
      <p data-testid="pagination-range" className="m-0 text-[0.8125rem] text-ink-soft tabular-nums max-sm:order-last max-sm:col-span-2 max-sm:text-center" aria-live="polite">{`${view.from}–${view.to} de ${view.matched}`}</p>
      <button data-testid="pagination-previous" type="button" aria-label="Página anterior" className="min-w-[auto] w-[var(--control-height)] flex-none px-0 max-sm:w-full" disabled={view.page <= 1} onClick={() => view.setPage(view.page - 1)}>
        <Icon name="arrow-left" size={16} />
        <span className="sm:hidden" aria-hidden="true">Anterior</span>
      </button>
      <button data-testid="pagination-next" type="button" aria-label="Próxima página" className="min-w-[auto] w-[var(--control-height)] flex-none px-0 max-sm:w-full" disabled={view.page >= view.pages} onClick={() => view.setPage(view.page + 1)}>
        <span className="sm:hidden" aria-hidden="true">Próxima</span>
        <Icon name="arrow-right" size={16} />
      </button>
      </div>
    </nav>
  );
}
