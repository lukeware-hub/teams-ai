/** Regexes shared by contracts that must also load in the browser (no node: imports here). */
export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** Three digits (`AC-001`), or four and more with no leading zero (`AC-1000`): one way to write each number. */
export const AC_ID = /^AC-(?:\d{3}|[1-9]\d{3,})$/;
