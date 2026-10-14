import { useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icons.js';
import { Select } from './Select.js';

export type SortValue = string | number | null;
type Sort = { key: string; direction: 'asc' | 'desc' } | null;

// Numeric collation puts "T2" before "T10"; empty values always go last.
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const compare = (a: SortValue, b: SortValue) => (typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b)));

/** Sorting by column, a text search and one dropdown filter over a table's rows. A third click on a header returns to the original order. */
export function useTableView<T>(rows: T[], by: { sorts: Record<string, (row: T) => SortValue>; text: (row: T) => string[]; facet: (row: T) => string; facetLabel: (value: string) => string }) {
  const [sort, setSort] = useState<Sort>(null);
  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q !== '' || facet !== '';
  const matching = rows.filter((r) => (facet === '' || by.facet(r) === facet) && (q === '' || by.text(r).some((v) => v.toLowerCase().includes(q))));
  const value = sort ? by.sorts[sort.key] : undefined;
  const shown = value && sort
    ? [...matching].sort((a, b) => {
        const x = value(a);
        const y = value(b);
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
        return sort.direction === 'asc' ? compare(x, y) : compare(y, x);
      })
    : matching;
  const options = [...new Set(rows.map(by.facet))].map((v) => ({ value: v, label: by.facetLabel(v) })).sort((a, b) => collator.compare(a.label, b.label));
  return {
    rows: shown,
    total: rows.length,
    sort,
    query,
    facet,
    options,
    filtered,
    setQuery,
    setFacet,
    toggleSort: (key: string) => setSort(sort?.key !== key ? { key, direction: 'asc' } : sort.direction === 'asc' ? { key, direction: 'desc' } : null),
    clear: () => {
      setQuery('');
      setFacet('');
    },
  };
}

type View = ReturnType<typeof useTableView<unknown>>;

/** A column header that sorts on click; `tip` stays outside the button so the two controls never nest. */
export function SortHeader({ view, column, className, tip, children }: { view: Pick<View, 'sort' | 'toggleSort'>; column: string; className?: string; tip?: ReactNode; children: ReactNode }) {
  const active = view.sort?.key === column ? view.sort.direction : null;
  return (
    <th scope="col" className={`whitespace-nowrap ${className ?? ''}`} aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined}>
      <button
        type="button"
        className="inline-flex h-auto min-h-0 items-center gap-1 border-0 bg-transparent p-0 font-[inherit] text-[inherit] tracking-[inherit] uppercase hover:not-disabled:bg-transparent hover:not-disabled:text-ink"
        onClick={() => view.toggleSort(column)}
      >
        {children}
        <span className={active ? 'text-accent-text' : 'text-ink-faint'}>
          <Icon name={active === 'asc' ? 'sort-up' : active === 'desc' ? 'sort-down' : 'sort'} size={14} />
        </span>
      </button>
      {tip}
    </th>
  );
}

/** Search box, dropdown filter, match count and a clear button, above a table. */
export function TableFilters({ view, subject, placeholder, facetName }: { view: View; subject: string; placeholder: string; facetName: string }) {
  const search = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label className="relative block min-w-0 flex-[0_1_20rem] max-md:basis-full [&_svg]:pointer-events-none [&_svg]:absolute [&_svg]:top-1/2 [&_svg]:left-3 [&_svg]:-translate-y-1/2 [&_svg]:text-ink-faint">
        <span className="sr-only">Filtrar {subject}</span>
        <Icon name="search" size={16} />
        <input ref={search} className="w-full min-w-0 appearance-none pl-[2.375rem]" type="search" value={view.query} onChange={(e) => view.setQuery(e.target.value)} placeholder={placeholder} />
      </label>
      {view.options.length > 1 ? (
        <label className="block min-w-0 flex-none max-md:basis-full">
          <span className="sr-only">{facetName}</span>
          <Select wrapperClassName="md:w-48" value={view.facet} onChange={(e) => view.setFacet(e.target.value)}>
            <option value="">{facetName}: todos</option>
            {view.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </label>
      ) : null}
      {view.filtered ? (
        <button
          type="button"
          aria-label="Limpar filtros"
          className="w-[var(--control-height)] flex-none px-0"
          onClick={() => {
            view.clear();
            search.current?.focus();
          }}
        >
          <Icon name="close" size={16} />
        </button>
      ) : null}
      <p className="m-0 text-[0.8125rem] text-ink-soft tabular-nums" aria-live="polite">{view.filtered ? `${view.rows.length} de ${view.total}` : ''}</p>
    </div>
  );
}
