/** One page of a table, cut on the server: `total` counts every row, `matched` the rows the search and facet keep. */
export interface Page<T> {
  total: number;
  matched: number;
  page: number;
  size: number;
  pages: number;
  /** Every value the facet can take, unfiltered, so the filter lists them all. */
  facets: string[];
  list: T[];
}

/** The query a table page asks for: one page, a text search, a facet and a sort. */
export interface PageRequest {
  page: number;
  size: number;
  q: string;
  facet: string;
  sort: string | null;
  dir: 'asc' | 'desc';
}

export type SortValue = string | number | null;

/** How a table's rows are sorted, searched and faceted; a missing part means the table has none. */
export interface TableSpec<T> {
  sorts?: Record<string, (row: T) => SortValue>;
  text?: (row: T) => string[];
  facet?: (row: T) => string;
}

export const PAGE_SIZES = [5, 10, 50, 100] as const;
const DEFAULT_SIZE = 10;

const positive = (v: string | null, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Reads a table's page query; a size outside PAGE_SIZES and a page below one fall back to the defaults. */
export function pageRequest(query: URLSearchParams): PageRequest {
  const size = positive(query.get('size'), DEFAULT_SIZE);
  return {
    page: positive(query.get('page'), 1),
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_SIZE,
    q: (query.get('q') ?? '').trim().toLowerCase(),
    facet: query.get('facet') ?? '',
    sort: query.get('sort'),
    dir: query.get('dir') === 'desc' ? 'desc' : 'asc',
  };
}

// Numeric collation puts "T2" before "T10"; empty values always go last.
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const compare = (a: SortValue, b: SortValue) => (typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b)));

/** Filters and sorts the rows by the request, then cuts the page; the page number stays within the pages that exist. */
export function queryPage<T>(rows: T[], spec: TableSpec<T>, req: PageRequest): Page<T> {
  const matching = rows.filter(
    (r) => (req.facet === '' || spec.facet?.(r) === req.facet) && (req.q === '' || (spec.text?.(r) ?? []).some((v) => v.toLowerCase().includes(req.q))),
  );
  const value = req.sort ? spec.sorts?.[req.sort] : undefined;
  const sorted = value
    ? [...matching].sort((a, b) => {
        const x = value(a);
        const y = value(b);
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
        return req.dir === 'asc' ? compare(x, y) : compare(y, x);
      })
    : matching;
  const pages = Math.max(1, Math.ceil(sorted.length / req.size));
  const page = Math.min(req.page, pages);
  const facets = spec.facet ? [...new Set(rows.map(spec.facet))] : [];
  return {
    total: rows.length,
    matched: sorted.length,
    page,
    size: req.size,
    pages,
    facets,
    list: sorted.slice((page - 1) * req.size, page * req.size),
  };
}
