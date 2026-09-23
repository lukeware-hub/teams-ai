export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };
