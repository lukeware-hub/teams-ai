export type License = {
  id: string;
  status: 'pending' | 'active' | 'disabled' | 'expired';
  expiresAt?: string;
  validForDays?: number;
  activatedAt?: string;
  disabledAt?: string;
  createdAt: string;
  key?: string;
};

export type Settings = { contactEmail: string; contactPhone: string };

const TEXT: Record<string, string> = {
  'invalid credentials': 'E-mail ou senha inválidos.',
  unauthorized: 'Sessão expirada. Entre novamente.',
  'license not found': 'Licença não encontrada.',
  'set a date or a period, not both': 'Informe uma data ou um período, não os dois.',
  'expiry must be in the future': 'A validade precisa ser uma data futura.',
  'set a future expiry or clear it before enabling': 'Defina uma data futura ou remova a validade antes de habilitar.',
  'license is not activated': 'A licença ainda não foi ativada.',
  'status must be active or disabled': 'O estado precisa ser ativo ou desativado.',
  'period must be at least 1 day': 'O período precisa ter pelo menos 1 dia.',
  'expiry must be an RFC3339 date': 'Data inválida.',
};

export const STATUS_LABEL: Record<License['status'], string> = {
  pending: 'Pendente',
  active: 'Ativa',
  disabled: 'Desativada',
  expired: 'Expirada',
};

export function statusClass(status: License['status']): string {
  if (status === 'active') return 'chip chip-active';
  if (status === 'pending') return 'chip chip-pending';
  return 'chip chip-off';
}

export function when(value?: string): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR');
}

export function toRFC3339(local: string): string {
  return new Date(local).toISOString();
}

const TOKEN = 'license.token';

export function readToken(): string | null {
  return sessionStorage.getItem(TOKEN);
}

export function saveToken(token: string): void {
  sessionStorage.setItem(TOKEN, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('content-type', 'application/json');
  const token = readToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/admin/login') {
      clearToken();
      location.assign('/login/');
    }
    throw new Error(TEXT[body.error ?? ''] ?? 'Não foi possível concluir a operação.');
  }
  return body;
}
