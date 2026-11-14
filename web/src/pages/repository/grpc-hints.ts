const READ_NAME = /^(Get|List|Search|Watch|Describe)/;
const ADVICE: Record<string, string> = {
  UNAUTHENTICATED: 'O serviço pede credenciais: preencha Cabeçalhos, por exemplo authorization.',
  PERMISSION_DENIED: 'O serviço recusou: a credencial enviada não tem permissão para este método.',
  INVALID_ARGUMENT: 'A requisição não passou na validação: confira os campos do JSON.',
  UNAVAILABLE: 'O serviço não respondeu: confira se o sistema está no ar.',
  NOT_FOUND: 'A chamada foi aceita, mas o serviço não achou o registro: o Exemplo usa identificadores novos que não existem, troque por um que exista.',
};

/** A hint from the method's name: reading methods start with a reading verb, the rest may write. */
export const isRead = (method: string): boolean => READ_NAME.test(method);

/** `kh.policy_registry.v1.PolicyRegistryService` shown as `PolicyRegistryService`. */
export const shortService = (service: string): string => service.split('.').at(-1) ?? service;

/** One line saying what to do about a failed call, from the `NAME (code): message` the server sends; null when there is no advice for it. */
export const adviceFor = (error: string): string | null => {
  if (/^(não foi possível conectar|o serviço não respondeu)/.test(error)) return ADVICE.UNAVAILABLE ?? null;
  return ADVICE[/^([A-Z_]+) \(/.exec(error)?.[1] ?? ''] ?? null;
};

/** The status chip of a call: `0 OK` when it ran, `16 UNAUTHENTICATED` for the gRPC status the server sent, `Erro` when there is none (no answer at all). */
export const statusOf = (result: { ok: boolean; error: string }): string => (result.ok ? '0 OK' : (/^([A-Z_]+) \((\d+)\)/.exec(result.error)?.slice(1).reverse().join(' ') ?? 'Erro'));

/** The JSON of a response laid out for reading; the text as it came when it is not one JSON value. */
export const prettyJson = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;
const ID_KEY = /^id$|(Id|Key)$/;
const SIZE_KEY = /limit|size|count/i;
const STRUCT_KEY = 'google.protobuf.Struct';

/**
 * A request with sample values from the empty template grpcurl gives for a message: a new UUID for ids and keys,
 * the current time for dates, 10 for a limit, 1 for other numbers and `exemplo` for text. Values the template
 * already names (enum values, durations, booleans) stay as they are. Anything that is not JSON comes back unchanged.
 */
export function exampleOf(template: string, now: Date = new Date(), uuid: () => string = () => crypto.randomUUID()): string {
  const fill = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => fill(item, key));
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      // A free-form object (a protobuf Struct) is shown as a hint, not as a field to fill.
      if (entries.length === 1 && entries[0]![0] === STRUCT_KEY) return {};
      return Object.fromEntries(entries.map(([k, v]) => [k, fill(v, k)]));
    }
    if (typeof value === 'number') return value === 0 ? (SIZE_KEY.test(key) ? 10 : 1) : value;
    if (typeof value !== 'string') return value;
    if (ISO_DATE.test(value)) return now.toISOString();
    if (/^\d+$/.test(value)) return value === '0' ? (SIZE_KEY.test(key) ? '10' : '1') : value;
    if (value !== '') return value;
    return ID_KEY.test(key) ? uuid() : 'exemplo';
  };
  try {
    return JSON.stringify(fill(JSON.parse(template), ''), null, 2);
  } catch {
    return template;
  }
}

/** The headers text with its `authorization` line replaced by `line` (or added), so a second token replaces the first. */
export const withAuthorization = (headers: string, line: string): string =>
  [line, ...headers.split('\n').filter((l) => l.trim() !== '' && !/^\s*authorization\s*:/i.test(l))].join('\n');

/** When the access token in an `authorization: Bearer …` line stops being valid, from its `exp` claim; null when the line holds no readable token. */
export function tokenExpiry(line: string): Date | null {
  try {
    const payload = line.split('.')[1];
    const exp = (JSON.parse(atob((payload ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}
